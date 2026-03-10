const http = require('http');

// Simple HTTP server for Railway
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CheetahCV Bot is alive!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Health server on port ${PORT}`));const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { supabase } = require('../services/supabase');
const { extractText, structureCV } = require('../services/cv-parser');
const { tailorCV } = require('../services/cv-tailor');

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

// /start command
bot.command('start', async (ctx) => {
  var telegramId = ctx.from.id;
  var { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!existing) {
    await supabase.from('users').insert({
      telegram_id: telegramId,
      telegram_username: ctx.from.username || null,
      full_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    });
  }

  await ctx.reply(
    'Welcome to CheetahCV! 🚀\n\n'
    + 'I help you land jobs faster by:\n'
    + '• Tailoring your CV to each job automatically\n'
    + 'I find jobs within minutes of them being posted '
    + 'and help you apply with a perfect CV.\n\n'
    + 'Upload your master CV to get started!'
  );
});

// /search command
bot.command('search', async (ctx) => {
  userStates.set(ctx.from.id, { step: 'keywords' });
  
  await ctx.reply(
    'Great! Let\'s set up your job alerts.\n\n'
    + 'What keywords should I search for? (e.g., "software engineer", "product manager")\n'
    + 'Send them as a comma-separated list.'
  );
});

// /mysearches - View all active search profiles
bot.command('mysearches', async (ctx) => {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', ctx.from.id)
    .single();

  const { data: searches } = await supabase
    .from('search_profiles')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_active', true);

  if (!searches || searches.length === 0) {
    return ctx.reply('You don\'t have any active job searches.\n\nUse /search to create one!');
  }

  await ctx.reply(`🔍 You have ${searches.length} active search${searches.length !== 1 ? 'es' : ''}:`);
  
  for (const search of searches) {
    const workTypes = search.work_types?.join(', ') || 'all types';
    const companies = search.target_companies?.join(', ') || 'Any company';
    
    const keyboard = new InlineKeyboard()
      .text('✏️ Edit', 'edit_search_' + search.id)
      .text('🗑️ Delete', 'delete_search_' + search.id);
    
    await ctx.reply(
      `📋 ${search.keywords.join(', ')}\n`
      + `📍 ${search.location || 'Anywhere'}\n`
      + `💼 ${workTypes}\n`
      + `🏢 ${companies}`,
      { reply_markup: keyboard }
    );
  }
});

// /clearalerts - Clear all new alerts
bot.command('clearalerts', async (ctx) => {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', ctx.from.id)
    .single();

  const { data: alerts } = await supabase
    .from('alerts')
    .update({ status: 'dismissed' })
    .eq('user_id', user.id)
    .eq('status', 'new')
    .select();

  const count = alerts?.length || 0;
  
  await ctx.reply(`✅ Cleared ${count} alert${count !== 1 ? 's' : ''}.\n\nYou won't see them in /alerts anymore.`);
});

// /alerts command with pagination
bot.command('alerts', async (ctx) => {
  await showAlerts(ctx, 0);
});

async function showAlerts(ctx, page = 0) {
  var { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', ctx.from.id)
    .single();

  // Auto-dismiss old alerts (older than 48 hours)
  await supabase
    .from('alerts')
    .update({ status: 'expired' })
    .eq('user_id', user.id)
    .eq('status', 'new')
    .select('jobs!inner(posted_at, created_at)')
    .then(({ data: alerts }) => {
      if (alerts) {
        alerts.forEach(async (alert) => {
          const job = alert.jobs;
          const postedDate = job.posted_at || job.created_at;
          if (isJobTooOld(postedDate)) {
            await supabase
              .from('alerts')
              .update({ status: 'expired' })
              .eq('id', alert.id);
          }
        });
      }
    });

  // Get fresh alerts (less than 48 hours old)
  var { data: allAlerts } = await supabase
    .from('alerts')
    .select('*, jobs(*)')
    .eq('user_id', user.id)
    .eq('status', 'new');

  // Filter out jobs older than 48 hours
  const recentAlerts = allAlerts?.filter(alert => {
    const job = alert.jobs;
    const postedDate = job.posted_at || job.created_at;
    return !isJobTooOld(postedDate);
  }) || [];

  if (recentAlerts.length === 0) {
    return ctx.reply('No new alerts yet. I will message you when I find matching jobs!\n\n💡 Jobs older than 48 hours are automatically removed.\n\nUse /mysearches to view your active searches.');
  }

  const totalPages = Math.ceil(recentAlerts.length / ALERTS_PER_PAGE);
  const start = page * ALERTS_PER_PAGE;
  const end = start + ALERTS_PER_PAGE;
  const alertsToShow = recentAlerts.slice(start, end);

  await ctx.reply(
    `You have ${recentAlerts.length} recent job alert${recentAlerts.length !== 1 ? 's' : ''}\n`
    + `Showing ${start + 1}-${Math.min(end, recentAlerts.length)} of ${recentAlerts.length}\n`
    + `📄 Page ${page + 1} of ${totalPages}`
  );

  for (var i = 0; i < alertsToShow.length; i++) {
    var job = alertsToShow[i].jobs;
    
    var keyboard = new InlineKeyboard();
    
    const applyUrl = job.apply_url || `https://www.google.com/search?q=${encodeURIComponent(job.title + ' ' + job.company)}`;
    
    keyboard.url('Apply Now', applyUrl).row();
    keyboard.text('Tailor CV', 'tailor_' + job.id).text('Dismiss', 'dismiss_' + alertsToShow[i].id);
    
    const timePosted = job.posted_at || job.created_at;
    const postedText = timePosted ? `\n⏰ Posted ${timeAgo(timePosted)}` : '';

    await ctx.reply(
      '💼 ' + job.title + '\n'
      + '🏢 ' + (job.company || 'Company not listed') + '\n'
      + '📍 ' + (job.location || 'Not specified') + (job.is_remote ? ' (Remote)' : '')
      + postedText + '\n\n'
      + (job.description ? job.description.substring(0, 500) + '...' : 'No description'),
      { reply_markup: keyboard }
    );
  }
  
  // Pagination buttons
  if (totalPages > 1) {
    const navKeyboard = new InlineKeyboard();
    
    if (page > 0) {
      navKeyboard.text('⬅️ Previous', `alerts_page_${page - 1}`);
    }
    
    if (page < totalPages - 1) {
      navKeyboard.text('Next ➡️', `alerts_page_${page + 1}`);
    }
    
    await ctx.reply('Navigate:', { reply_markup: navKeyboard });
  }
  
  await ctx.reply('💡 Tip: Jobs older than 48 hours are automatically removed. Use /clearalerts to dismiss all.');
}

// /help command
bot.command('help', async (ctx) => {
  await ctx.reply(
    '🤖 CHEETAHCV COMMANDS:\n\n'
    + '📄 CV Management:\n'
    + '/start - Upload your master CV\n\n'
    + '🔍 Job Search:\n'
    + '/search - Set up new job alerts\n'
    + '/mysearches - View, edit & delete searches\n\n'
    + '📬 Alerts:\n'
    + '/alerts - View new job alerts (last 48hrs)\n'
    + '/clearalerts - Dismiss all alerts\n\n'
    + '/help - Show this message'
  );
});

// Handle document uploads (CV)
bot.on('message:document', async (ctx) => {
  await ctx.reply('Got your CV! Analysing...');

  var { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', ctx.from.id)
    .single();

  if (!user) {
    await supabase.from('users').insert({
      telegram_id: ctx.from.id,
      telegram_username: ctx.from.username || null,
      full_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    });
    var { data: newUser } = await supabase.from('users').select('id').eq('telegram_id', ctx.from.id).single();
    user = newUser;
  }

  try {
    var file = await ctx.getFile();
    var fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    var response = await fetch(fileUrl);
    var buffer = await response.arrayBuffer();
    var mime = ctx.message.document.mime_type;

    var rawText = await extractText(buffer, mime);
    var structured = await structureCV(rawText);

    var ext = mime.includes('pdf') ? 'pdf' : 'docx';
    await supabase.storage
      .from('cvs')
      .upload(user.id + '/master-cv.' + ext, buffer, {
        contentType: mime,
        upsert: true,
      });

    var { data: existingCv } = await supabase
      .from('master_cvs')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (existingCv) {
      await supabase
        .from('master_cvs')
        .update({ structured_data: structured })
        .eq('id', existingCv.id);
    } else {
      await supabase
        .from('master_cvs')
        .insert({
          user_id: user.id,
          file_url: user.id + '/master-cv.' + ext,
          structured_data: structured,
        });
    }

    var keyboard = new InlineKeyboard()
      .text('Looks good', 'cv_confirmed')
      .text('Re-upload', 'cv_reupload');

    await ctx.reply(
      'CV processed! Here is what I found:\n\n'
      + 'Name: ' + (structured.personal_info?.name || 'Not found') + '\n'
      + 'Roles: ' + (structured.experience?.length || 0) + ' found\n'
      + 'Skills: ' + ((structured.skills?.technical?.length || 0) + (structured.skills?.tools?.length || 0)) + ' identified\n\n'
      + 'Does this look right?',
      { reply_markup: keyboard }
    );
  } catch (error) {
    console.error('CV parse error:', error);
    await ctx.reply('Sorry, I had trouble processing your CV. Please try again or contact support.');
  }
});

// Handle text messages for search setup and editing
bot.on('message:text', async (ctx) => {
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', ctx.from.id)
    .single();
  
  if (!user) return;
  
  if (state.step === 'keywords') {
    state.keywords = ctx.message.text;
    state.step = 'location';
    userStates.set(ctx.from.id, state);
    
    await ctx.reply(
      'Got it! Where would you like to search?\n'
      + '(e.g., "London", "Manchester", "United Kingdom")\n\n'
      + 'Or send "anywhere" for no location filter.'
    );
  } else if (state.step === 'location') {
    state.location = ctx.message.text === 'anywhere' ? null : ctx.message.text;
    state.step = 'companies';
    userStates.set(ctx.from.id, state);
    
    await ctx.reply(
      'Do you want to filter by specific companies?\n\n'
      + 'Send company names separated by commas (e.g., "Google, Meta, Amazon")\n'
      + 'Or send "any" to see jobs from all companies.'
    );
  } else if (state.step === 'companies') {
    const text = ctx.message.text.toLowerCase();
    state.companies = (text === 'any' || text === 'all') ? null : ctx.message.text.split(',').map(c => c.trim());
    state.step = 'work_type';
    userStates.set(ctx.from.id, state);
    
    const keyboard = new InlineKeyboard()
      .text('Office', 'wt_office').text('Hybrid', 'wt_hybrid').text('Remote', 'wt_remote').row()
      .text('Office + Hybrid', 'wt_office_hybrid').row()
      .text('Hybrid + Remote', 'wt_hybrid_remote').row()
      .text('All types', 'wt_all');
    
    await ctx.reply(
      'What work types are you interested in?',
      { reply_markup: keyboard }
    );
  } else if (state.step === 'edit_keywords') {
    // Editing keywords
    const searchId = state.searchId;
    const newKeywords = ctx.message.text.split(',').map(k => k.trim());
    
    await supabase
      .from('search_profiles')
      .update({ keywords: newKeywords })
      .eq('id', searchId);
    
    await ctx.reply(`✅ Updated keywords to: ${newKeywords.join(', ')}`);
    userStates.delete(ctx.from.id);
  } else if (state.step === 'edit_location') {
    // Editing location
    const searchId = state.searchId;
    const newLocation = ctx.message.text === 'anywhere' ? null : ctx.message.text;
    
    await supabase
      .from('search_profiles')
      .update({ location: newLocation })
      .eq('id', searchId);
    
    await ctx.reply(`✅ Updated location to: ${newLocation || 'Anywhere'}`);
    userStates.delete(ctx.from.id);
  } else if (state.step === 'edit_companies') {
    // Editing companies
    const searchId = state.searchId;
    const text = ctx.message.text.toLowerCase();
    const newCompanies = (text === 'any' || text === 'all') ? null : ctx.message.text.split(',').map(c => c.trim());
    
    await supabase
      .from('search_profiles')
      .update({ target_companies: newCompanies })
      .eq('id', searchId);
    
    await ctx.reply(`✅ Updated companies to: ${newCompanies ? newCompanies.join(', ') : 'Any company'}`);
    userStates.delete(ctx.from.id);
  }
});

// Handle callback queries
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  
  if (data === 'cv_confirmed') {
    await ctx.answerCallbackQuery('Great! Your CV is saved.');
    await ctx.reply('Perfect! Now use /search to set up job alerts.');
  } else if (data === 'cv_reupload') {
    await ctx.answerCallbackQuery();
    await ctx.reply('No problem! Send me your updated CV.');
  } else if (data.startsWith('alerts_page_')) {
    const page = parseInt(data.replace('alerts_page_', ''));
    await ctx.answerCallbackQuery();
    await showAlerts(ctx, page);
  } else if (data.startsWith('edit_search_')) {
    const searchId = data.replace('edit_search_', '');
    await ctx.answerCallbackQuery();
    
    const keyboard = new InlineKeyboard()
      .text('Edit Keywords', 'edit_keywords_' + searchId).row()
      .text('Edit Location', 'edit_location_' + searchId).row()
      .text('Edit Companies', 'edit_companies_' + searchId).row()
      .text('Edit Work Types', 'edit_worktypes_' + searchId).row()
      .text('Cancel', 'cancel_edit');
    
    await ctx.reply('What would you like to edit?', { reply_markup: keyboard });
  } else if (data.startsWith('edit_keywords_')) {
    const searchId = data.replace('edit_keywords_', '');
    await ctx.answerCallbackQuery();
    
    userStates.set(ctx.from.id, { step: 'edit_keywords', searchId });
    await ctx.reply('Send me the new keywords (comma-separated):');
  } else if (data.startsWith('edit_location_')) {
    const searchId = data.replace('edit_location_', '');
    await ctx.answerCallbackQuery();
    
    userStates.set(ctx.from.id, { step: 'edit_location', searchId });
    await ctx.reply('Send me the new location (or "anywhere"):');
  } else if (data.startsWith('edit_companies_')) {
    const searchId = data.replace('edit_companies_', '');
    await ctx.answerCallbackQuery();
    
    userStates.set(ctx.from.id, { step: 'edit_companies', searchId });
    await ctx.reply('Send me the company names (comma-separated, or "any" for all companies):');
  } else if (data.startsWith('edit_worktypes_')) {
    const searchId = data.replace('edit_worktypes_', '');
    await ctx.answerCallbackQuery();
    
    const keyboard = new InlineKeyboard()
      .text('Office', 'update_wt_office_' + searchId).text('Hybrid', 'update_wt_hybrid_' + searchId).text('Remote', 'update_wt_remote_' + searchId).row()
      .text('Office + Hybrid', 'update_wt_office_hybrid_' + searchId).row()
      .text('Hybrid + Remote', 'update_wt_hybrid_remote_' + searchId).row()
      .text('All types', 'update_wt_all_' + searchId);
    
    await ctx.reply('Select new work types:', { reply_markup: keyboard });
  } else if (data.startsWith('update_wt_')) {
    const parts = data.replace('update_wt_', '').split('_');
    const searchId = parts.pop();
    const wtType = parts.join('_');
    
    let workTypes = [];
    if (wtType === 'office') workTypes = ['office'];
    else if (wtType === 'hybrid') workTypes = ['hybrid'];
    else if (wtType === 'remote') workTypes = ['remote'];
    else if (wtType === 'office_hybrid') workTypes = ['office', 'hybrid'];
    else if (wtType === 'hybrid_remote') workTypes = ['hybrid', 'remote'];
    else if (wtType === 'all') workTypes = ['office', 'hybrid', 'remote'];
    
    await supabase
      .from('search_profiles')
      .update({ work_types: workTypes })
      .eq('id', searchId);
    
    await ctx.answerCallbackQuery('Updated!');
    await ctx.editMessageText(`✅ Updated work types to: ${workTypes.join(', ')}`);
  } else if (data === 'cancel_edit') {
    await ctx.answerCallbackQuery('Cancelled');
    await ctx.editMessageText('Edit cancelled.');
    userStates.delete(ctx.from.id);
  } else if (data.startsWith('delete_search_')) {
    const searchId = data.replace('delete_search_', '');
    
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('telegram_id', ctx.from.id)
      .single();
    
    const { data: search } = await supabase
      .from('search_profiles')
      .select('*')
      .eq('id', searchId)
      .eq('user_id', user.id)
      .single();
    
    if (search) {
      await supabase
        .from('search_profiles')
        .update({ is_active: false })
        .eq('id', searchId);
      
      await ctx.answerCallbackQuery('Search deleted');
      await ctx.editMessageText(`❌ Deleted: ${search.keywords.join(', ')} in ${search.location || 'Anywhere'}`);
    }
  } else if (data.startsWith('dismiss_')) {
    const alertId = data.replace('dismiss_', '');
    
    await supabase
      .from('alerts')
      .update({ status: 'dismissed' })
      .eq('id', alertId);
    
    await ctx.answerCallbackQuery('Alert dismissed');
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  } else if (data.startsWith('wt_')) {
    const state = userStates.get(ctx.from.id);
    if (!state) return;
    
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('telegram_id', ctx.from.id)
      .single();
    
    let workTypes = [];
    let displayText = '';
    
    if (data === 'wt_office') {
      workTypes = ['office'];
      displayText = 'Office only';
    } else if (data === 'wt_hybrid') {
      workTypes = ['hybrid'];
      displayText = 'Hybrid only';
    } else if (data === 'wt_remote') {
      workTypes = ['remote'];
      displayText = 'Remote only';
    } else if (data === 'wt_office_hybrid') {
      workTypes = ['office', 'hybrid'];
      displayText = 'Office + Hybrid';
    } else if (data === 'wt_hybrid_remote') {
      workTypes = ['hybrid', 'remote'];
      displayText = 'Hybrid + Remote';
    } else if (data === 'wt_all') {
      workTypes = ['office', 'hybrid', 'remote'];
      displayText = 'All types';
    }
    
    await supabase.from('search_profiles').insert({
      user_id: user.id,
      keywords: state.keywords.split(',').map(k => k.trim()),
      location: state.location,
      target_companies: state.companies,
      work_types: workTypes,
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '✅ Job search set up!\n\n'
      + `Keywords: ${state.keywords}\n`
      + `Location: ${state.location || 'Anywhere'}\n`
      + `Companies: ${state.companies ? state.companies.join(', ') : 'Any company'}\n`
      + `Work types: ${displayText}\n\n`
      + 'I\'ll start searching for jobs and send you alerts!'
    );
    
    userStates.delete(ctx.from.id);
  } else if (data.startsWith('tailor_')) {
    const jobId = data.replace('tailor_', '');
    await ctx.answerCallbackQuery('Generating tailored CV...');
    await ctx.reply('🔄 Creating your tailored CV... This will take a moment.');
    
    try {
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('telegram_id', ctx.from.id)
        .single();
      
      const { pdfPath, job } = await tailorCV(user.id, jobId);
      
      await ctx.replyWithDocument(new InputFile(pdfPath), {
        caption: `✅ Your tailored CV for ${job.title} at ${job.company}\n\nThis CV has been customized to highlight your most relevant experience and skills for this role. Good luck! 🚀`
      });
      
      const fs = require('fs');
      fs.unlinkSync(pdfPath);
      
    } catch (error) {
      console.error('Tailoring error:', error);
      await ctx.reply('Sorry, I had trouble tailoring your CV. Please make sure you\'ve uploaded a master CV first using /start.');
    }
  }
});

// Error handler
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  
  if (err.error.description?.includes('query is too old')) {
    console.log('Ignoring old callback query');
    return;
  }
  
  try {
    ctx.reply('Sorry, something went wrong. Please try again.').catch(() => {});
  } catch (e) {
    console.error('Could not send error message to user');
  }
});

bot.start();
console.log('CheetahCV bot is running...');
