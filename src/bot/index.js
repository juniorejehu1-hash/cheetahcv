require('dotenv').config();
const http = require('http');
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { supabase } = require('../services/supabase');
const { extractText, structureCV } = require('../services/cv-parser');
const { tailorCV } = require('../services/cv-tailor');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CheetahCV Bot is alive!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Health server on port ${PORT}`));

const bot = new Bot(process.env.BOT_TOKEN);
const userStates = new Map();
const ALERTS_PER_PAGE = 10;
const MAX_ALERT_AGE_HOURS = 48;

function timeAgo(date) {
  const now = new Date();
  const posted = new Date(date);
  const diffMs = now - posted;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 60) return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

function isJobTooOld(postedDate) {
  if (!postedDate) return false;
  const now = new Date();
  const posted = new Date(postedDate);
  const hoursDiff = (now - posted) / (1000 * 60 * 60);
  return hoursDiff > MAX_ALERT_AGE_HOURS;
}

bot.command('start', async (ctx) => {
  const telegramId = ctx.from.id;
  const { data: existing } = await supabase.from('users').select('id').eq('telegram_id', telegramId).maybeSingle();
  if (!existing) {
    await supabase.from('users').insert({
      telegram_id: telegramId,
      telegram_username: ctx.from.username || null,
      full_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    });
  }
  await ctx.reply('Welcome to CheetahCV! 🚀\n\nI help you land jobs faster by tailoring your CV to each job automatically.\n\nUpload your master CV to get started!');
});

bot.command('search', async (ctx) => {
  userStates.set(ctx.from.id, { step: 'keywords' });
  await ctx.reply('What keywords should I search for? (e.g., "software engineer")\nSend them as a comma-separated list.');
});

bot.command('mysearches', async (ctx) => {
  const { data: user } = await supabase.from('users').select('id').eq('telegram_id', ctx.from.id).single();
  const { data: searches } = await supabase.from('search_profiles').select('*').eq('user_id', user.id).eq('is_active', true);
  if (!searches || searches.length === 0) return ctx.reply('You don\'t have any active job searches.\n\nUse /search to create one!');
  await ctx.reply(`🔍 You have ${searches.length} active search${searches.length !== 1 ? 'es' : ''}:`);
  for (const search of searches) {
    const workTypes = search.work_types?.join(', ') || 'all types';
    const companies = search.target_companies?.join(', ') || 'Any company';
    const keyboard = new InlineKeyboard().text('✏️ Edit', 'edit_search_' + search.id).text('🗑️ Delete', 'delete_search_' + search.id);
    await ctx.reply(`📋 ${search.keywords.join(', ')}\n📍 ${search.location || 'Anywhere'}\n💼 ${workTypes}\n🏢 ${companies}`, { reply_markup: keyboard });
  }
});

bot.command('alerts', async (ctx) => {
  const { data: user } = await supabase.from('users').select('id').eq('telegram_id', ctx.from.id).single();
  const { data: alerts } = await supabase.from('alerts').select('*, jobs(*)').eq('user_id', user.id).eq('status', 'new');
  const recent = alerts?.filter(a => !isJobTooOld(a.jobs.posted_at || a.jobs.created_at)) || [];
  if (recent.length === 0) return ctx.reply('No new alerts!');
  for (const alert of recent.slice(0, 10)) {
    const job = alert.jobs;
    const kb = new InlineKeyboard().url('Apply', job.apply_url || 'https://google.com').row().text('Tailor CV', 'tailor_' + job.id);
    await ctx.reply(`💼 ${job.title}\n🏢 ${job.company}\n📍 ${job.location}`, { reply_markup: kb });
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply('Commands:\n/start - Begin\n/search - Set alerts\n/mysearches - View searches\n/alerts - View alerts');
});

bot.on('message:text', async (ctx) => {
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  const { data: user } = await supabase.from('users').select('id').eq('telegram_id', ctx.from.id).single();
  if (state.step === 'keywords') {
    state.keywords = ctx.message.text;
    state.step = 'location';
    userStates.set(ctx.from.id, state);
    await ctx.reply('Where to search? (e.g., "London" or "anywhere")');
  } else if (state.step === 'location') {
    state.location = ctx.message.text === 'anywhere' ? null : ctx.message.text;
    state.step = 'companies';
    userStates.set(ctx.from.id, state);
    await ctx.reply('Filter by companies? (e.g., "Google, Meta" or "any")');
  } else if (state.step === 'companies') {
    const text = ctx.message.text.toLowerCase();
    state.companies = (text === 'any') ? null : ctx.message.text.split(',').map(c => c.trim());
    state.step = 'work_type';
    userStates.set(ctx.from.id, state);
    const kb = new InlineKeyboard().text('Office', 'wt_office').text('Hybrid', 'wt_hybrid').text('Remote', 'wt_remote').row().text('All', 'wt_all');
    await ctx.reply('Work types?', { reply_markup: kb });
  }
});

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith('wt_')) {
    const state = userStates.get(ctx.from.id);
    if (!state) return;
    const { data: user } = await supabase.from('users').select('id').eq('telegram_id', ctx.from.id).single();
    let workTypes = data === 'wt_office' ? ['office'] : data === 'wt_hybrid' ? ['hybrid'] : data === 'wt_remote' ? ['remote'] : ['office', 'hybrid', 'remote'];
    await supabase.from('search_profiles').insert({ user_id: user.id, keywords: state.keywords.split(',').map(k => k.trim()), location: state.location, target_companies: state.companies, work_types: workTypes });
    await ctx.answerCallbackQuery();
    await ctx.reply('✅ Search created!');
    userStates.delete(ctx.from.id);
  } else if (data.startsWith('delete_search_')) {
    await supabase.from('search_profiles').update({ is_active: false }).eq('id', data.replace('delete_search_', ''));
    await ctx.answerCallbackQuery('Deleted');
    await ctx.editMessageText('Search deleted');
  }
});

bot.catch((err) => console.error('Bot error:', err));
bot.start();
console.log('CheetahCV bot is running...');
