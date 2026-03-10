require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;
const { supabase } = require('./supabase');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function tailorCV(userId, jobId) {
  const { data: masterCV } = await supabase
    .from('master_cvs')
    .select('structured_data')
    .eq('user_id', userId)
    .single();

  if (!masterCV) {
    throw new Error('No master CV found');
  }

  const { data: job } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) {
    throw new Error('Job not found');
  }

  const prompt = `You are an ATS-optimized CV tailoring expert. Create a bespoke CV for this specific job.

## CRITICAL RULES - ABSOLUTE REQUIREMENTS:

### Accuracy & Honesty (NEVER VIOLATE):
1. **NEVER invent or fabricate**: No fake experience, skills, achievements, dates, or certifications
2. **NEVER add skills/tools the candidate doesn't have**: If it's not in the master CV, don't add it
3. **NEVER change factual details**: Keep all dates, company names, job titles, and education exactly as provided
4. **NEVER exaggerate**: No inflated numbers, responsibilities, or achievements
5. **Only use information from the master CV**: Everything must be verifiable and truthful

### What You CAN Do:
- **Reorder sections**: Put most relevant experience first
- **Emphasize relevant details**: Highlight achievements that match the job requirements
- **Tailor the summary**: Align professional summary with the target role (2-3 sentences max)
- **Select relevant skills**: Choose skills from their existing list that match the job
- **Use job keywords naturally**: Incorporate relevant keywords where they genuinely apply
- **Reorganize bullet points**: Lead with most relevant achievements for this specific role
- **Remove less relevant details**: Focus on what matters for this job (but don't delete entire roles)

### ATS Optimization:
- Mirror keywords from the job description where truthful
- Use standard section headers: EXPERIENCE, EDUCATION, SKILLS
- Include relevant metrics and achievements from master CV
- Ensure clean, parseable structure

## JOB DETAILS:
Title: ${job.title}
Company: ${job.company}
Description: ${job.description}

## MASTER CV DATA:
${JSON.stringify(masterCV.structured_data, null, 2)}

## OUTPUT FORMAT:
Return ONLY valid JSON (no markdown, no explanation):
{
  "personal_info": { "name": "", "email": "", "phone": "", "location": "", "linkedin": "" },
  "summary": "2-3 sentence professional summary tailored for this specific role",
  "experience": [
    {
      "title": "EXACT job title from master CV",
      "company": "EXACT company name from master CV", 
      "start_date": "EXACT date from master CV",
      "end_date": "EXACT date from master CV",
      "bullets": ["Most relevant achievements first, keeping all facts accurate"]
    }
  ],
  "education": [{ "degree": "EXACT degree", "institution": "EXACT institution", "year": "EXACT year" }],
  "skills": { 
    "technical": ["Only skills they actually have that are relevant"],
    "tools": ["Only tools they actually use"],
    "soft": ["Only soft skills demonstrated in their experience"]
  },
  "certifications": ["Only real certifications from master CV"],
  "projects": [{ "name": "Real project name", "description": "Real project description" }]
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = message.content[0].text;
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  const tailoredData = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);

  const { data: tailoredCV } = await supabase
    .from('tailored_cvs')
    .insert({
      user_id: userId,
      job_id: jobId,
      structured_data: tailoredData,
    })
    .select()
    .single();

  const pdfPath = await generatePDF(tailoredData, job);

  return { tailoredCV, tailoredData, job, pdfPath };
}

async function generatePDF(cvData, job) {
  return new Promise((resolve, reject) => {
    const fileName = `${cvData.personal_info.name.replace(/\s/g, '_')}_CV.pdf`;
    const filePath = path.join('/tmp', fileName);
    
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);
    
    doc.pipe(stream);
    
    // Header with name
    doc.fontSize(24).font('Helvetica-Bold').text(cvData.personal_info.name, { align: 'center' });
    doc.moveDown(0.3);
    
    // Contact info
    doc.fontSize(10).font('Helvetica');
    const contactInfo = [
      cvData.personal_info.email,
      cvData.personal_info.phone,
      cvData.personal_info.location,
      cvData.personal_info.linkedin
    ].filter(Boolean).join(' | ');
    doc.text(contactInfo, { align: 'center' });
    doc.moveDown(1.5);
    
    // Summary
    if (cvData.summary) {
      doc.fontSize(14).font('Helvetica-Bold').text('PROFESSIONAL SUMMARY');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text(cvData.summary, { align: 'justify' });
      doc.moveDown(1);
    }
    
    // Experience
    if (cvData.experience && cvData.experience.length > 0) {
      doc.fontSize(14).font('Helvetica-Bold').text('EXPERIENCE');
      doc.moveDown(0.5);
      
      cvData.experience.forEach(exp => {
        doc.fontSize(12).font('Helvetica-Bold').text(exp.title);
        doc.fontSize(10).font('Helvetica').text(`${exp.company} | ${exp.start_date} - ${exp.end_date}`);
        doc.moveDown(0.3);
        
        if (exp.bullets && exp.bullets.length > 0) {
          exp.bullets.forEach(bullet => {
            doc.fontSize(10).text(`• ${bullet}`, { indent: 20 });
          });
        }
        doc.moveDown(0.7);
      });
    }
    
    // Education
    if (cvData.education && cvData.education.length > 0) {
      doc.fontSize(14).font('Helvetica-Bold').text('EDUCATION');
      doc.moveDown(0.5);
      
      cvData.education.forEach(edu => {
        doc.fontSize(11).font('Helvetica-Bold').text(edu.degree);
        doc.fontSize(10).font('Helvetica').text(`${edu.institution} | ${edu.year}`);
        doc.moveDown(0.5);
      });
    }
    
    // Skills
    if (cvData.skills) {
      doc.fontSize(14).font('Helvetica-Bold').text('SKILLS');
      doc.moveDown(0.5);
      
      if (cvData.skills.technical && cvData.skills.technical.length > 0) {
        doc.fontSize(10).font('Helvetica-Bold').text('Technical: ', { continued: true });
        doc.font('Helvetica').text(cvData.skills.technical.join(', '));
        doc.moveDown(0.3);
      }
      
      if (cvData.skills.tools && cvData.skills.tools.length > 0) {
        doc.fontSize(10).font('Helvetica-Bold').text('Tools: ', { continued: true });
        doc.font('Helvetica').text(cvData.skills.tools.join(', '));
        doc.moveDown(0.3);
      }
    }
    
    doc.end();
    
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

module.exports = { tailorCV };
