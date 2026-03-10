require('dotenv').config();
const { supabase } = require('../services/supabase');
const { Bot } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

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

async function searchJobs(keywords, location = 'United Kingdom', workTypes = ['office', 'hybrid', 'remote']) {
  let remoteParam = '';
  if (workTypes.length === 1 && workTypes[0] === 'remote') {
    remoteParam = '&remote_jobs_only=true';
  }
  
  const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(keywords)}${location ? `&location=${encodeURIComponent(location)}` : ''}${remoteParam}&page=1&num_pages=1&date_posted=today`;
  
  const response = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
    }
  });
  
  if (!response.ok) {
    console.error('JSearch API error:', response.status);
    return [];
  }
  
  const data = await response.json();
  return data.data || [];
}

function matchesWorkType(job, workTypes) {
  if (workTypes.length === 3) return true;
  if (workTypes.includes('remote') && job.job_is_remote) return true;
  if (workTypes.includes('office') && !job.job_is_remote) return true;
  if (workTypes.includes('hybrid')) return true;
  return false;
}

function matchesLocation(job, targetLocation) {
  if (!targetLocation) return true;
  
  const jobCountry = (job.job_country || '').toLowerCase();
  const jobCity = (job.job_city || '').toLowerCase();
  const target = targetLocation.toLowerCase().trim();
  
  const ukVariants = ['london', 'manchester', 'birmingham', 'edinburgh', 'glasgow', 'leeds', 'uk', 'united kingdom', 'britain'];
  const ieVariants = ['dublin', 'cork', 'galway', 'ireland', 'ie'];
  
  const targetWantsUK = ukVariants.some(v => target.includes(v));
  const targetWantsIE = ieVariants.some(v => target.includes(v));
  
  const jobIsUS = jobCountry === 'us' || jobCountry === 'usa' || jobCountry === 'united states';
  const jobIsUK = jobCountry === 'gb' || jobCountry === 'uk' || jobCountry === 'united kingdom';
  const jobIsIE = jobCountry === 'ie' || jobCountry === 'ireland';
  
  if (targetWantsUK && jobIsUS) {
    console.log(`  ❌ Blocked: ${job.job_title} - User wants UK, job is in US`);
    return false;
  }
  
  if (targetWantsIE && !jobIsIE) {
    console.log(`  ❌ Blocked: ${job.job_title} - User wants Ireland, job is in ${jobCountry}`);
    return false;
  }
  
  if (target.includes('london') && !jobCity.includes('london')) {
    console.log(`  ❌ Blocked: ${job.job_title} - User wants London, job is in ${jobCity}`);
    return false;
  }
  
  if (target.includes('dublin') && !jobCity.includes('dublin')) {
    console.log(`  ❌ Blocked: ${job.job_title} - User wants Dublin, job is in ${jobCity}`);
    return false;
  }
  
  if (target.includes('manchester') && !jobCity.includes('manchester')) {
    console.log(`  ❌ Blocked: ${job.job_title} - User wants Manchester, job is in ${jobCity}`);
    return false;
  }
  
  return true;
}

function matchesCompany(job, targetCompanies) {
  if (!targetCompanies || targetCompanies.length === 0) return true;
  
  const jobCompany = (job.employer_name || '').toLowerCase();
  
  for (const targetCompany of targetCompanies) {
    if (jobCompany.includes(targetCompany.toLowerCase())) {
      return true;
    }
  }
  
  console.log(`  ❌ Blocked: ${job.job_title} at ${job.employer_name} - Not in target companies: ${targetCompanies.join(', ')}`);
  return false;
}

async function sendJobAlert(telegramId, job) {
  try {
    const { InlineKeyboard } = require('grammy');
    
    const applyUrl = job.apply_url || `https://www.google.com/search?q=${encodeURIComponent(job.title + ' ' + job.company)}`;
    
    const keyboard = new InlineKeyboard();
    keyboard.url('Apply Now', applyUrl).row();
    keyboard.text('Tailor CV', 'tailor_' + job.id);
    
    const timePosted = job.posted_at || job.created_at;
    const postedText = timePosted ? `\n⏰ Posted ${timeAgo(timePosted)}` : '';
    
    await bot.api.sendMessage(
      telegramId,
      '🔔 NEW JOB ALERT!\n\n'
      + '💼 ' + job.title + '\n'
      + '🏢 ' + (job.company || 'Company not listed') + '\n'
      + '📍 ' + (job.location || 'Not specified') + (job.is_remote ? ' (Remote)' : '')
      + postedText + '\n\n'
      + (job.description ? job.description.substring(0, 500) + '...' : 'No description'),
      { reply_markup: keyboard }
    );
    
    console.log(`  📨 Sent notification to user ${telegramId}`);
  } catch (error) {
    console.error('Error sending notification:', error);
  }
}

async function pollJobs() {
  console.log('🔍 Polling for new jobs...');
  
  const { data: profiles } = await supabase
    .from('search_profiles')
    .select('*, users!inner(telegram_id)');
  
  if (!profiles || profiles.length === 0) {
    console.log('No search profiles found');
    return;
  }
  
  for (const profile of profiles) {
    const workTypes = profile.work_types || ['office', 'hybrid', 'remote'];
    const targetCompanies = profile.target_companies || null;
    
    for (const keyword of profile.keywords) {
      console.log(`Searching for: ${keyword} in ${profile.location || 'anywhere'} (${workTypes.join(', ')})${targetCompanies ? ` at ${targetCompanies.join(', ')}` : ''}`);
      
      const jobs = await searchJobs(keyword, profile.location, workTypes);
      
      const filteredJobs = jobs.filter(job => 
        matchesWorkType(job, workTypes) && 
        matchesLocation(job, profile.location) &&
        matchesCompany(job, targetCompanies)
      );
      
      console.log(`Found ${jobs.length} jobs, ${filteredJobs.length} match after filtering`);
      
      for (const job of filteredJobs) {
        const { data: existing } = await supabase
          .from('jobs')
          .select('id')
          .eq('jsearch_id', job.job_id)
          .maybeSingle();
        
        if (existing) {
          console.log(`  ⏭️  Skipping existing job: ${job.job_title}`);
          continue;
        }
        
        const { data: newJob, error } = await supabase
          .from('jobs')
          .insert({
            jsearch_id: job.job_id,
            title: job.job_title,
            company: job.employer_name,
            location: job.job_city ? `${job.job_city}, ${job.job_country}` : job.job_country,
            description: job.job_description,
            apply_url: job.job_apply_link,
            is_remote: job.job_is_remote,
            posted_at: job.job_posted_at_datetime_utc,
          })
          .select()
          .single();
        
        if (error) {
          console.error('Error saving job:', error);
          continue;
        }
        
        await supabase.from('alerts').insert({
          user_id: profile.user_id,
          job_id: newJob.id,
          search_profile_id: profile.id,
          status: 'new',
        });
        
        console.log(`  ✅ New job: ${job.job_title} at ${job.employer_name} (${newJob.location})`);
        
        await sendJobAlert(profile.users.telegram_id, newJob);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log('✅ Job polling complete');
}

async function start() {
  console.log('🚀 Job poller started with auto-notifications');
  
  while (true) {
    try {
      await pollJobs();
    } catch (error) {
      console.error('Error polling jobs:', error);
    }
    
    await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000));
  }
}

start();
