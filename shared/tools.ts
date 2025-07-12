import { tool } from '@langchain/core/tools';
import { z } from 'zod';


// This is our dummy 'email' sending tool
export const writeEmail = tool((input: {to: string; subject: string; content: string}) => {
	// Note this is a placeholder, in reality we would send an email.
	return `Email sent to ${input.to} with subject ${input.subject} and content: ${input.content}`;
}, {
	name: 'write_email',
	description: 'Write and send an email.',
	schema: z.object({
		to: z.string().describe('The email address of the recipient.'),
		subject: z.string().describe('A title describing the email\'s subject.'),
		content: z.string().describe('The full text of the email.')
	})
});


// This is our dummy 'scheduling' tool
export const scheduleMeeting = tool((input: {attendees: array; subject: string; durationMinutes: int; prefferedDay: date; startTime: int}) => {
	return `Meeting '${input.subject}' scheduled on ${input.prefferedDay} at ${input.startTime} for ${input.durationMinutes} minutes with ${input.attendees.length} attendees.`;
}, {
	name: 'schedule_meeting',
	description: 'Schedule a calendar meeting.',
	schema: z.object({
		attendees: z.array(z.string()).describe('A list of the meeting\'s attendees names.'),
		subject: z.string().describe('A description of the meetings main purpose.'),
		durationMinutes: z.number().describe('The number of minutes the meeting will last.'),
		preferredDay: z.string().date().describe('The day the meeting will be held.'),
		startTime: z.number().describe('The hour at which the meeting starts.')
	})
});


// This is our dummy 'calendar checker' tool
export const checkCalendarAvailability = tool((input: {day: string}) => {
	return `Available times on ${input.day}: 9:00 AM, 2:00 PM, 4:00 PM`
},{
	name: 'check_calendar_availability',
	description: 'Check calendar availability for a given day',
	schema: z.object({
		day: z.string()
	})
});


// A tool to let us know the email was sent
export const done = tool((input) => {
	return true;
},{
	name: `Done`,
	description: 'E-mail has been sent.'
});


// A tool added for the human-in-the-loop assistant
export const question = tool((input: {content: string}) => {
	return input.content;
},{
	name: 'question',
	description: 'Question to ask user.',
	schema: z.object({
		content: z.string()
	})
});
