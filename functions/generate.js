// functions/generate.js

// We are NOT using the 'openai' library anymore. We use the built-in fetch.

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

  // --- We build the request manually ---

  // The specific API endpoint for OpenRouter's chat completions
  const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

  // The headers required by OpenRouter
  const headers = {
    'Authorization': `Bearer ${process.env.FREE_MODEL_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://secureapi.online',
    'X-Title': 'SecureAPI',
  };

  // The body of the request, formatted as JSON
  const body = JSON.stringify({
    model: 'mistralai/devstral-small',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
  });

  try {
    // We use the standard 'fetch' command. No library, no magic.
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: body,
    });

    const data = await response.json();

    // If the response is not OK, we throw the error from the API itself.
    if (!response.ok) {
      console.error('OpenRouter API Error:', data);
      throw new Error(data.error?.message || 'Failed to generate workflow file.');
    }
    
    const generatedYml = data.choices[0].message.content;
    const cleanedYml = generatedYml.replace(/```yaml\n|```/g, '').trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ymlContent: cleanedYml }),
    };

  } catch (err) {
    console.error('Top-level error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate the workflow file. The free model may be temporarily unavailable.' }) };
  }
};