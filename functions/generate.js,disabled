// functions/generate.js

// Using require to ensure it works in your Netlify environment
const fetch = require('node-fetch');

exports.handler = async function (event) {
  // LOG 1: Announce that the function has started.
  console.log('--- Generate function started ---');

  // LOG 2: Check if the required environment variable is even loaded.
  const apiKey = process.env.FREE_MODEL_API_KEY;
  if (!apiKey) {
    console.error('CRITICAL ERROR: FREE_MODEL_API_KEY is not defined!');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: API key is missing.' }) };
  }
  console.log('API Key is loaded successfully.');

  if (event.httpMethod !== 'POST') {
    console.log('Incorrect HTTP method. Exiting.');
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // LOG 3: Log the incoming request body to see what we received.
  console.log('Received request body:', event.body);
  const { mainFile, language, deploymentTarget } = JSON.parse(event.body);

  const prompt = `
    You are an expert DevOps engineer who creates GitHub Actions workflow files.
    A user wants to deploy their project. Generate a complete, production-ready \`.yml\` file for them.
    Project Details:
    - Programming Language: ${language}
    - Main script file to run: ${mainFile}
    - Deployment Target: ${deploymentTarget}
    Instructions: The entire output must be ONLY the YAML code, enclosed in a single markdown code block.
  `;

  const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://secureapi.online',
    'X-Title': 'SecureAPI',
  };
  const body = JSON.stringify({
    model: 'mistralai/devstral-small',
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    // LOG 4: Announce that we are about to make the API call.
    console.log('Attempting to fetch from OpenRouter...');

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: body,
    });

    // LOG 5: Log the status of the response.
    console.log(`Received response with status: ${response.status}`);
    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter API returned an error:', data);
      throw new Error(data.error?.message || 'Failed to generate workflow file.');
    }
    
    // LOG 6: Announce that the API call was successful.
    console.log('API call successful. Processing response...');
    const generatedYml = data.choices[0].message.content;
    const cleanedYml = generatedYml.replace(/```yaml\n|```/g, '').trim();

    console.log('--- Function finished successfully ---');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ymlContent: cleanedYml }),
    };

  } catch (err) {
    // LOG 7: This is the most important log. It will catch any error.
    console.error('--- CATCH BLOCK ERROR ---');
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate the workflow file. The free model may be temporarily unavailable.' }) };
  }
};