import { z } from 'zod';
import { StateGraph, START, END } from '@langchain/langgraph';

// This is the state for the cron service
export const state = z.object({
	name: z.string(),
	check: z.string()
});

// Run the email ingestion process
async function timeCheck(state: state) {
	return {check: `Hi ${state.name} it is ${new Date().toISOString()}`};
}


export const graph = new StateGraph(state)
	.addNode('time_check', timeCheck)
	.addEdge(START, 'time_check')
	.addEdge('time_check', END)
	.compile();
