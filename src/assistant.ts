import 'dotenv/config';
import { formatEmailMarkdown, formatForDisplay, showGraph } from '../shared/utils.ts';
import { TRIAGE_SYSTEM_PROMPT, DEFAULT_BACKGROUND, DEFAULT_TRIAGE_INSTRUCTIONS,
	TRIAGE_USER_PROMPT, AGENT_SYSTEM_PROMPT_HITL, HITL_TOOLS_PROMPT,
	DEFAULT_RESPONSE_PREFERENCES, DEFAULT_CAL_PREFERENCES } from '../shared/prompts.ts';
import { writeEmail, scheduleMeeting, checkCalendarAvailability, done, question } from '../shared/tools.ts';
import format from 'string-template';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { StateGraph, MessagesAnnotation, Annotation, START, END, Command, interrupt } from '@langchain/langgraph';

// Let's set up a models that can do something for us
const llmNode = new ChatOpenAI({model: 'gpt-4.1', temperature: 0});
const llmAgent = new ChatOpenAI({model: 'gpt-4.1', temperature: 0});

//////////// State ////////////

// Now let's define our state
const state = Annotation.Root({
	...MessagesAnnotation.spec,													// Merge in the MessagesAnnotation
	emailInput: Annotation<Record<string, any>>({								// Let's use a Record in place of a Python dict
    	default: () => {}
	}),
	classificationDescision: Annotation<'ignore' | 'respond' | 'notify'>({		// These form our literals and we default to 'ignore'
		default: () => {'ignore'}
	})
});

//////////// Structured response ////////////

// Now lets use Zod to define an output schema
const routerSchema = z.object({
	reasoning: z.string().describe('Step-by-step reasoning behind the classification.'),
	classification: z.enum(['ignore', 'respond', 'notify']).describe(`The classification of an email:
		'ignore' for irrelevant emails,
		'notify' for important information that doesn't need a response,
		'respond' for emails that need a reply`)
});

// Now we can define our routing LLM and provide it with our strutured output schema
// This should coerce the output to match the schema
const llmRouter = llmNode.withStructuredOutput(routerSchema, {name: 'route'});

//////////// Node and Command ////////////

// Now we can build our router node
async function triageRouter(state: state) {
	// Data for the Command object we return
	let goto = '';
	let update = {};

	// Set up the systemPrompt with the defaults
	const systemPrompt = format(TRIAGE_SYSTEM_PROMPT,{
		background: DEFAULT_BACKGROUND,
		triageInstructions: DEFAULT_TRIAGE_INSTRUCTIONS
	});

	// Destructure the emailInput and set up the user prompt
	const {author, to, subject, emailThread} = state.emailInput;
	const userPrompt = format(TRIAGE_USER_PROMPT,{
		author: author,
		to: to,
		subject: subject,
		emailThread: emailThread
	});

	// Now were good to call the LLM and get the routing decision
	const result = await llmRouter.invoke([
		{role: 'system', content: systemPrompt},
		{role: 'user', content: userPrompt}
	]);

	// Build up the command data based on the response
	switch (result.classification) {
		case 'respond':
			goto = 'response_agent';
			update = {
				classificationDecision: result.classification,
				messages: [{
					role: 'user',
					content: 'Respond to the email: \n\n' + formatEmailMarkdown(subject, author, to, emailThread)
				}]
			};
			break;
		case 'ignore':
			goto = END;
			update = {
				classificationDecision: result.classification
			};
			break;
		case 'notify':
			// HITL Note now we go to the interrupt handler instead of END
			goto = 'triage_interrupt_handler';
			update = {
				classificationDecision: result.classification
			};
			break;
		default:
			throw new Error('Invalid classification: ' + result.classification);
			break;
	}
	// Now return a command telling us where we go next and update the state.
	return new Command({
		goto: goto,
		update: update
	});
}

// HITL Note this is the new triage_interrupt_handler node
// A node to handle interrupts from the triage step
async function triageInterruptHandler(state: state) {
	// destructure the email input and format to markdown
	const {author, to, subject, emailThread} = state.emailInput;
	const emailMarkdown = formatEmailMarkdown(author, to, subject, emailThread);

	// Construct a message
	const messages = [{
		role: 'user',
		content: `Email to notify user about: ${emailMarkdown}`
	}];

	// Now create the interrupt, the proprty names are defined by Agent Inbox
	const request = {
		action_request: {
			action: `Email Assistant: ${state.classificationDescision}`,
			args: {}
		},
		// Options to render in Agent Inbox
		config: {
			allow_ignore: true,
			allow_respond: true,
			allow_edit: false,
			allow_accept: false
        },
		// Email to show in Agent Inbox
		description: emailMarkdown
	};

	// Agent Inbox returns a Record with a single key `type` that can be `accept`, `edit`, `ignore`, or `response`.
	const response = interrupt([request])[0];

	// If user provides feedback, go to response agent and use feedback to respond to email
	switch (response.type) {
		case 'response':
			// Add the user feedback to the messages
			const userInput = response.args;
			// Add the message
			messages.push({
				role: 'user',
				content: `User wants to reply to the email. Use this feedback to respond: ${userInput}`
			});
			// Route to the response agent
			goto = 'response_agent';
			break;
		case 'ignore':
			// User wants to ignore this so end
			goto = END;
			break;
		default:
			// In case we get an unexpected type
			throw new Error(`Invalid response: ${JSON.stringify(response, null, 2)}`);
			break;
	}

	// Put the messages in the update
	const update = {messages: messages};

	// Now return a command telling us where we go next and update the state.
	return new Command({
		goto: goto,
		update: update
	});
}

//////////// AGENT ////////////
// NB we could have used the createReactAgent for this, but this breaks it down for us.

// First let's set up the tools lists,
// HITL Note we are adding question to the tool roster!
const tools = [writeEmail, scheduleMeeting, checkCalendarAvailability, question, done];
const toolsByName = tools.reduce((acc, tool) => {
  acc[tool.name] = tool;
  return acc;
}, {});


// Now we set up a new LLM this one with the tools and no response schema
const llmWithTools = llmAgent.bindTools(tools, {tool_choice: 'required'});


// LLM Node
async function llmCall(state: state) {
	const systemPrompt = format(AGENT_SYSTEM_PROMPT_HITL, {
		toolsPrompt: HITL_TOOLS_PROMPT,						// HITL Note, updated to include the question tool
		date: new Date().toISOString().split('T')[0],
		background: DEFAULT_BACKGROUND,
		responsePreferences: DEFAULT_RESPONSE_PREFERENCES,
		calPreferences: DEFAULT_CAL_PREFERENCES
	});

	const result = await llmWithTools.invoke([{
		role: 'system',
		content: systemPrompt
	},
	...state.messages
	]);

	return {messages: result};
}

// HITL Note we no longer use the toolHandler

// HITL Node creates an interrupt for human review of tool calls
async function interruptHandler(state:state) {
	// Store the messages
	const result =[];

	// Default to goto the llmCall node next
	let goto = 'llm_call';

	// Go thru the tool calls
	for (const toolCall of state.messages[state.messages.length-1].tool_calls) {
		// Allowed HITL tools
		const hitlTools = ['write_email', 'schedule_meeting', 'question'];

		// Let's see if the tool call is an HITL tool?
		if (hitlTools.includes(toolCall.name)) {
			// SETUP of the interrupt
			// Get the email input
			const {author, to, subject, emailThread} = state.emailInput;
			const emailMarkdown = formatEmailMarkdown(author, to, subject, emailThread);
			// Format the tool call for display
			const toolDisplay = formatForDisplay(toolCall);
			// Create the description
			const description = emailMarkdown + toolDisplay;

			// Now lets configure the Agent inbox rendering based on the tool
			let config = {};
			switch (toolCall.name) {
				case 'write_email':
					config = {
						allow_ignore: true,
						allow_respond: true,
						allow_edit: true,
						allow_accept: true
					};
					break;
				case 'schedule_meeting':
					config = {
						allow_ignore: true,
						allow_respond: true,
						allow_edit: true,
						allow_accept: true
					};
					break;
				case 'question':
					config = {
						allow_ignore: true,
						allow_respond: true,
						allow_edit: false,
						allow_accept: false
					};
					break;
				default:
					throw new Error('Invalid tool call: ' + toolCall.name);
					break;
			}

			// Now let's configure the interrupt request
			const request = {
				action_request: {
					action: toolCall.name,
					args: toolCall.args
				},
				config: config,
				description: description
			};


			// INTERRUPT send to the Agent inbox and wait
			const response = await interrupt([request])[0];

			// RESPONSE handeling
			// Now lets handle the response we got back
			switch (response.type) {
				case 'accept':
					// Execute the tool with original args
					const tool = toolsByName[toolCall.name];
					const observation = await tool.invoke(toolCall.args);
					result.push({role: 'tool', content: observation, tool_call_id: toolCall.id});
					break;

				case 'edit':
					// Check this is a valid tool to edit
					if (toolCall.name == 'write_email' || toolCall.name == 'schedule_meeting' ) {
						// Get the tool
						const tool = toolsByName[toolCall.name];
						// Get the new args
						const editedArgs = response.args.args;
						// Now let's update the AI tool call message with the new args
						const aiMessage = state.messages[state.messages.length-1];

						// Create a new tool list by filtering out the tool being edited
						// then add the updated version, this avoids editing the origional list
						const updatedToolCalls = [
							...aiMessage.tool_calls.filter(tc => tc.id !== toolCall.id),
							{type: 'tool_call', name: toolCall.name, args: editedArgs, id: toolCall.id}
						];

						// Create a new message with the updated tool call to preserve
						// state immutability to prevent side effects. When we do the update
						// below with {messages: result} the addMessages reducer overwrites
						// the existing messages by id
						result.push({
							role: 'ai',
							content: aiMessage.content,
							tool_calls: updatedToolCalls,
							id: aiMessage.id
						});

						// Now let's execute the tool with the new args
						// This keeps the message history consitent with the tool call results
						const observation = await tool.invoke(editedArgs);
						result.push({role: 'tool', content: observation, tool_call_id: toolCall.id});

					} else {
						throw new Error('Invalid tool call: ' + toolCall.name);
					}
					break;

				case 'ignore':
					// The user said to ignore this so we'll just END
					switch (toolCall.name) {
						case 'write_email':
							result.push({role: 'tool', content: 'User ignored this email draft. Ignore this email and end the workflow.', tool_call_id: toolCall.id});
							break;
						case 'schedule_meeting':
							result.push({role: 'tool', content: 'User ignored this calendar meeting draft. Ignore this email and end the workflow.', tool_call_id: toolCall.id});
							break;
						case 'question':
							result.push({role: 'tool', content: 'User ignored this question. Ignore this email and end the workflow.', tool_call_id: toolCall.id});
							break;
						default:
							throw new Error('Invalid tool call: ' + toolCall.name);
							break;
					}
					// In this case were canceling the action
					goto = END;
					break;

				case 'response':
					// Here we got some user feedback
					const userFeedback = response.args;
					// In these cases don't execute the tool but append the user feedback and try again
					switch (toolCall.name) {
						case 'write_email':
							result.push({role: 'tool', content: `User gave feedback, which can we incorporate into the email. Feedback: ${userFeedback}`, tool_call_id: toolCall.id});
							break;
						case 'schedule_meeting':
							result.push({role: 'tool', content: `User gave feedback, which can we incorporate into the meeting request. Feedback: ${userFeedback}`, tool_call_id: toolCall.id});
							break;
						case 'question':
							result.push({role: 'tool', content: `User answered the question, which can we can use for any follow up actions. Feedback: ${userFeedback}`, tool_call_id: toolCall.id});
							break;
						default:
							throw new Error('Invalid tool call: ' + toolCall.name);
							break;
					}
					break;

				default:
					throw new Error('Invalid response: ' + JSON.stringify(response, null, 2));
					break;
			}


		} else { // if the tool is not an HITL tool just execute it
			const tool = toolsByName[toolCall.name];
			const observation = await tool.invoke(toolCall.args);
			result.push({role: 'tool', content: observation, tool_call_id: toolCall.id});
		}
	}

	// Put the messages in the update
	const update = {messages: result};

	// Now return a command telling us where we go next and update the state.
	return new Command({
		goto: goto,
		update: update
	});
}

// Conditional Edges
async function shouldContinue(state: state) {
	let result = null;
	// get the last message
	const lastMessage = state.messages[state.messages.length-1];
	// See if we're done
	if (lastMessage.tool_calls) {
		for (const toolCall of lastMessage.tool_calls) {
			if (toolCall.name == 'Done') {
				result = END;
			} else {
				result = 'interrupt_handler'; // HITL Note update from the tool handler
			}
		}
	}

	return result;
}

// Build the Agent Graph
// Note we drop the llmCall -> toolHandler edge
const agent = new StateGraph(state)
	.addNode('llm_call', llmCall)
	.addNode('interrupt_handler', interruptHandler, { // HITL Note now we use the interrupt handler
		ends: ['llm_call', END]
	})
	.addEdge(START, 'llm_call')
	.addConditionalEdges('llm_call', shouldContinue, {'interrupt_handler': 'interrupt_handler', '__end__': END}) // HITL Note here we now reference the interrupt handler
	.compile();

//////////// Assistant ////////////
// Compose the router and the agent together
// Note that in JS we need to specify how the router ends
// Also we export the assistant this time
export const overallWorkflow = new StateGraph(state)
	.addNode('triage_router', triageRouter, { // HITL Note we can now route to the triageInterruptHandler
		ends: ['response_agent', 'triage_interrupt_handler', END]
	})
	.addNode('triage_interrupt_handler', triageInterruptHandler, { // HITL Note here is the new node
		ends: ['response_agent', END]
	})
	.addNode('response_agent', agent)
	.addEdge(START, 'triage_router');

export const emailAssistant = overallWorkflow.compile();

// Visualize the graph
// showGraph(emailAssistant, true);
