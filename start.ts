import { Command } from 'commander';
import { Client } from '@langchain/langgraph-sdk';
//import { v4 as uuid4 } from 'uuid';

const program = new Command();

// This script creates a scheduled cron job in LangGraph that periodically
// runs the email ingestion graph to process new emails.
program.description('Test app to run a cron job.')
	.requiredOption('-u --url <url>', 'URL of the LangGraph deployment')
	.option('-n --name <name>', 'Name to say Hi to', 'Fred')

program.parse();

const opts = program.opts();

await main(opts.url, opts.name);


async function main(url, name) {
	try {
		const schedule = '*/10 * * * *'; // Every ten mins
		// Conect to the server
		const apiUrl = url ? url : 'http://localhost:2024';

		const client = new Client({ apiUrl: url});

		// Set up the input to the graph
		const cronInput = {
			name: name
		};

		console.log(`URL: ${apiUrl}\n\nSchedule: ${schedule}\n\nInput: ${JSON.stringify(cronInput, null, 2)}`);

		// Create the cron job
		const cron = await client.crons.create(
			'cron',						// Graph name (found in the langgraph.json)
			{
				schedule: schedule, 	// A cron schedule expression : https://crontab.cronhub.io
				input: cronInput		// Input for the cron graph (see ../cron.ts)
			}
		);

		console.log(`Cron job created successfully with schedule: ${schedule}`);
		console.log(`Say hi to: ${name}`);

		return cron; // NB: Were returning this but not using it, we should use the cronID to delete this!
	} catch (err) {
		console.log(`Cron setup error: ${err}`);
		return null;
	}
}
