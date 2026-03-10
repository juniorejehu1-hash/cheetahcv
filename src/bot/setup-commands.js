require('dotenv').config();
const { Bot } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);

async function setupCommands() {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Upload your master CV' },
    { command: 'search', description: 'Set up new job alerts' },
    { command: 'alerts', description: 'View new job alerts' },
    { command: 'mysearches', description: 'View active searches' },
    { command: 'clearalerts', description: 'Dismiss all alerts' },
    { command: 'help', description: 'Show all commands' },
  ]);
  
  console.log('✅ Bot commands menu set up successfully!');
  process.exit(0);
}

setupCommands();
