require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

async function listModels() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('GEMINI_API_KEY missing');
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error('Error:', data.error.message);
      return;
    }
    console.log('Available Models:');
    data.models.forEach(m => {
      if (m.supportedGenerationMethods.includes('generateContent')) {
        console.log(`- ${m.name}`);
      }
    });
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

listModels();
