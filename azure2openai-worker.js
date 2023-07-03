
async function handleRequest(request, env) {
  const { pathname } = new URL(request.url);
  const [_, token, next, ...params] = pathname.split('/');

  if (/^v\d+$/.test(token)) {
    return proxy(request, env);
  } else if (token === env.ACCESS_TOKEN) {
    console.log('Accessing master handler');
    var result;
    if (request.method === 'DELETE') {
      await deleteUser(next, env);
      result = 'ok';
    } else if (next === 'register' || next === 'reset') {
      result = await registerUser(params[0], env);
    }

    if (!result) throw 'Invalid action';
    return new Response(`${result}\n`, {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  throw 'Access forbidden';
}

async function registerUser(user, env) {
  if (!user?.length) throw 'Invalid username1';

  const users = await env.KV.get("users", { type: 'json' }) || {};
  const key = generateAPIKey();
  users[user] = { key };
  await env.KV.put("users", JSON.stringify(users));
  return key;
}

async function deleteUser(user, env) {
  if (!user?.length) throw 'Invalid username2';

  const users = await env.KV.get("users", { type: 'json' }) || {};
  if (!users[user]) throw 'User not found';

  delete users[user];
  await env.KV.put("users", JSON.stringify(users));
}

function generateAPIKey() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let apiKey = 'sk-cfw';

  for (let i = 0; i < 45; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    apiKey += characters.charAt(randomIndex);
  }

  return apiKey;
}

async function proxy(request, env) {

  const headers = new Headers(request.headers);
  const authKey = 'Authorization';
  const token = headers.get(authKey).split(' ').pop();
  if (!token) {
    return new Response("Auth required", {
      status: 403
    });
  }

  // validate user
  const users = await env.KV.get("users", { type: 'json' }) || {};
  let name;
  for (let key in users)
    if (users[key].key === token)
      name = key;

  if (!name) {
    return new Response("Invalid token", {
      status: 403
    });
  }
  console.log(`User ${name} acepted.`);

  // The name of your Azure OpenAI Resource.
  const resourceName=env.RESOURCE_NAME

  // The deployment name you chose when you deployed the model.
  const mapper = {
      'gpt-3.5-turbo': env.DEPLOY_NAME_GPT35,
      'text-embedding-ada-002': env.DEPLOY_NAME_EMBEDDING
  };

  const apiVersion="2023-05-15"
  if (request.method === 'OPTIONS') {
    return handleOPTIONS(request)
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith("//")) {
    url.pathname = url.pathname.replace('/',"")
  }
  if (url.pathname === '/v1/chat/completions') {
    var path="chat/completions"
  } else if (url.pathname === '/v1/completions') {
    var path="completions"
  } else if (url.pathname === '/v1/models') {
    return handleModels(request,env)
  } else {
    return new Response('404 Not Found', { status: 404 })
  }

  let body;
  if (request.method === 'POST') {
    body = await request.json();
  }

  const modelName = body?.model;  
  const deployName = mapper[modelName] || '' 

  if (deployName === '') {
    return new Response('Missing model mapper', {
        status: 403
    });
  }
  const fetchAPI = `https://${resourceName}.openai.azure.com/openai/deployments/${deployName}/${path}?api-version=${apiVersion}`

  
  const payload = {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      "api-key": env.AZURE_OPENAI_API_KEY,
    },
    body: typeof body === 'object' ? JSON.stringify(body) : '{}',
  };

  let response = await fetch(fetchAPI, payload);
  response = new Response(response.body, response);
  response.headers.set("Access-Control-Allow-Origin", "*");

  if (body?.stream != true){
    return response
  } 

  let { readable, writable } = new TransformStream()
  stream(response.body, writable);
  return new Response(readable, response);

}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// support printer mode and add newline
async function stream(readable, writable) {
  const reader = readable.getReader();
  const writer = writable.getWriter();

  // const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
// let decodedValue = decoder.decode(value);
  const newline = "\n";
  const delimiter = "\n\n"
  const encodedNewline = encoder.encode(newline);

  let buffer = "";
  while (true) {
    let { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }); // stream: true is important here,fix the bug of incomplete line
    let lines = buffer.split(delimiter);

    // Loop through all but the last line, which may be incomplete.
    for (let i = 0; i < lines.length - 1; i++) {
      await writer.write(encoder.encode(lines[i] + delimiter));
      await sleep(20);
    }

    buffer = lines[lines.length - 1];
  }

  if (buffer) {
    await writer.write(encoder.encode(buffer));
  }
  await writer.write(encodedNewline)
  await writer.close();
}

async function handleModels(request,env) {
  const data = {
    "object": "list",
    "data": []  
  };

  // The deployment name you chose when you deployed the model.
  const mapper = {
      'gpt-3.5-turbo': env.DEPLOY_NAME_GPT35,
      'text-embedding-ada-002': env.DEPLOY_NAME_EMBEDDING
  };

  for (let key in mapper) {
    data.data.push({
      "id": key,
      "object": "model",
      "created": 1677610602,
      "owned_by": "openai",
      "permission": [{
        "id": "modelperm-M56FXnG1AsIr3SXq8BYPvXJA",
        "object": "model_permission",
        "created": 1679602088,
        "allow_create_engine": false,
        "allow_sampling": true,
        "allow_logprobs": true,
        "allow_search_indices": false,
        "allow_view": true,
        "allow_fine_tuning": false,
        "organization": "*",
        "group": null,
        "is_blocking": false
      }],
      "root": key,
      "parent": null
    });  
  }

  const json = JSON.stringify(data, null, 2);
  return new Response(json, {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleOPTIONS(request) {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*'
      }
    })
}


export default {
  async fetch(request, env) {
    return handleRequest(request, env).catch(err => new Response(err || 'Unknown reason', { status: 403 }))
  }
};
