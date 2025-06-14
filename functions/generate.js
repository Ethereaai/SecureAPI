// functions/generate.js

import OpenAI from 'openai';

// Initialize the OpenAI client to talk to OpenRouter
const api = new OpenAI({
  apiKey: process.env.FREE_MODEL_API_KEY,
  baseURL: process.env.FREE_MODEL_BASE_URL,
  // OpenRouter recommends these headers to identify your app
  defaultHeaders: {
    'HTTP-Referer': 'https://secureapi.online', // Your site URL
    'X-Title': 'SecureAPI', // Your project's name
  },
});

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const { mainFile, language, deploymentTarget } = JSON.parse(event.body);

  if (!mainFile || !language || !deploymentTarget) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required project details.' }) };
  }

  const prompt = `
    You are an expert DevOps engineer who creates GitHub Actions workflow files.
    A user wants to deploy their project. Generate a complete, production-ready \`.yml\` file for them.

    Project Details:
    - Programming Language: ${language}
    - Main script file to run: ${mainFile}
    - Deployment Target: ${deploymentTarget}

    Instructions:
    1. The workflow should be triggered on a 'push' to the 'main' branch.
    2. It should set up the correct environment for the language (e.g., setup-node, setup-python).
    3. It must include a step to install dependencies (e.g., npm install, pip install -r requirements.txt).
    4. If the target is 'Vercel' or 'Netlify', use their official GitHub Actions for deployment. The user will provide the necessary secrets.
    5. The entire output must be ONLY the YAML code, enclosed in a single markdown code block with the language set to yaml. Do not include any other text or explanations.
  `;

  try {
    const completion = await api.chat.completions.create({
      // We use the specific model identifier from your list
      model: 'mistralai/devstral-small',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    const generatedYml = completion.choices[0].message.content;

    // Clean up the response to ensure it's just the code
    const cleanedYml = generatedYml.replace(/```yaml\n|```/g, '').trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ymlContent: cleanedYml }),
    };

  } catch (err) {
    console.error('API error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate the workflow file. The free model may be temporarily unavailable.' }) };
  }
};