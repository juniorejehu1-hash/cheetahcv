require('dotenv').config();
const pdfParse = require('pdf-parse-fork');
const mammoth = require('mammoth');
const Anthropic = require('@anthropic-ai/sdk').default;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function extractText(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  } else {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return result.value;
  }
}

async function structureCV(rawText) {
  const prompt = 'You are a CV parser. Extract ALL information from this CV into structured JSON format:\n'
    + '{\n'
    + '  "personal_info": { "name": "", "email": "", "phone": "", "location": "", "linkedin": "" },\n'
    + '  "summary": "",\n'
    + '  "experience": [{ "title": "", "company": "", "start_date": "", "end_date": "", "bullets": [] }],\n'
    + '  "education": [{ "degree": "", "institution": "", "year": "" }],\n'
    + '  "skills": { "technical": [], "tools": [], "soft": [] },\n'
    + '  "certifications": [],\n'
    + '  "projects": [{ "name": "", "description": "" }]\n'
    + '}\n\n'
    + 'CV TEXT:\n'
    + rawText;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = message.content[0].text;
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
}

module.exports = { extractText, structureCV };
