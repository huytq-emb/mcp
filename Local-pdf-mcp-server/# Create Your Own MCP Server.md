\# Create Your Own MCP Server

\*A comprehensive guide to building custom Model Context Protocol (MCP) servers for RICA.\*

\*\*Professor:\*\* M. Da Ros    
\*\*Class:\*\* BTS SIO Bordeaux — Lycée Gustave Eiffel

\---

\#\# Table of Contents

1\. \[Introduction\](\#introduction)  
2\. \[Prerequisites\](\#prerequisites)  
3\. \[MCP Server Basics\](\#mcp-server-basics)  
4\. \[Creating a Node.js MCP Server\](\#creating-a-nodejs-mcp-server)  
5\. \[Creating a Python MCP Server\](\#creating-a-python-mcp-server)  
6\. \[Testing Your MCP Server\](\#testing-your-mcp-server)  
7\. \[Adding to RICA\](\#adding-to-rica)  
8\. \[Connecting to Remote HTTP MCP Servers\](\#connecting-to-remote-http-mcp-servers)  
9\. \[Best Practices\](\#best-practices)  
10\. \[Common Patterns\](\#common-patterns)  
11\. \[Troubleshooting\](\#troubleshooting)  
12\. \[Advanced Topics\](\#advanced-topics)  
13\. \[Complete Example: Weather MCP Server\](\#complete-example-weather-mcp-server)  
14\. \[Next Steps\](\#next-steps)  
15\. \[Summary Checklist\](\#summary-checklist)

\---

\#\# Introduction

\*\*MCP (Model Context Protocol)\*\* is a standard protocol for connecting AI assistants to external tools and services. By creating your own MCP server, you can extend RICA's capabilities with custom functionality.

\#\#\# What You'll Learn

\- ✅ Core MCP concepts  
\- ✅ How to define tools with input schemas  
\- ✅ Handle tool calls from RICA  
\- ✅ Test and debug MCP servers  
\- ✅ Deploy custom MCP servers

\---

\#\# Prerequisites

\#\#\# Required Knowledge

\- Basic programming (JavaScript or Python)  
\- Understanding of JSON  
\- Command line basics

\#\#\# Tools Needed

\#\#\#\# For Node.js

\`\`\`bash  
\# Node.js 18+ and npm  
node \--version  
npm \--version  
\`\`\`

\#\#\#\# For Python

\`\`\`bash  
\# Python 3.11+  
python \--version  
pip \--version  
\`\`\`

\---

\#\# MCP Server Basics

\#\#\# Core Concepts

1\. \*\*Tools\*\*: Functions that RICA can call  
2\. \*\*Input Schema\*\*: JSON Schema defining tool parameters  
3\. \*\*Transport\*\*: Communication layer (stdin/stdout)  
4\. \*\*Server\*\*: Handles tool list and execution

\#\#\# Communication Flow

\`\`\`text  
RICA Agent  
    ↓  
    │ 1\. List Tools Request  
    ↓  
MCP Server → Returns: \[tool1, tool2, tool3\]  
    ↓  
    │ 2\. Call Tool Request (name, arguments)  
    ↓  
MCP Server → Executes tool → Returns result  
    ↓  
    │ 3\. Result  
    ↓  
RICA Agent → Responds to user  
\`\`\`

\---

\#\# Creating a Node.js MCP Server

\#\#\# Step 1: Project Setup

\`\`\`bash  
mkdir my-mcp-server  
cd my-mcp-server  
npm init \-y  
npm install @modelcontextprotocol/sdk  
\`\`\`

Update \`package.json\`:

\`\`\`json  
{  
  "type": "module",  
  "dependencies": {  
    "@modelcontextprotocol/sdk": "^1.0.0"  
  }  
}  
\`\`\`

\#\#\# Step 2: Create Server File

Create \`index.js\`:

\`\`\`javascript  
import { Server } from "@modelcontextprotocol/sdk/server/index.js";  
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";  
import {  
  CallToolRequestSchema,  
  ListToolsRequestSchema,  
} from "@modelcontextprotocol/sdk/types.js";

// Create server instance  
const server \= new Server({  
  name: "my-mcp-server",  
  version: "1.0.0",  
});

// Define your tools  
const tools \= \[  
  {  
    name: "greet",  
    description: "Greet someone by name",  
    inputSchema: {  
      type: "object",  
      properties: {  
        name: {  
          type: "string",  
          description: "Person's name",  
        },  
      },  
      required: \["name"\],  
    },  
  },  
\];

// Handle ListTools request  
server.setRequestHandler(ListToolsRequestSchema, async () \=\> {  
  return { tools };  
});

// Handle CallTool request  
server.setRequestHandler(CallToolRequestSchema, async (request) \=\> {  
  const { name, arguments: args } \= request.params;

  try {  
    if (name \=== "greet") {  
      const greeting \= \`Hello, ${args.name}\!\`;  
      return {  
        content: \[  
          {  
            type: "text",  
            text: greeting,  
          },  
        \],  
      };  
    }

    return {  
      content: \[  
        { type: "text", text: \`Unknown tool: ${name}\` }  
      \],  
      isError: true,  
    };  
  } catch (error) {  
    return {  
      content: \[  
        { type: "text", text: \`Error: ${error.message}\` }  
      \],  
      isError: true,  
    };  
  }  
});

// Start server  
const transport \= new StdioServerTransport();  
await server.connect(transport);  
console.error("MCP Server started ✅");  
\`\`\`

\#\#\# Step 3: Add Multiple Tools

Extend your server with more tools:

\`\`\`javascript  
const tools \= \[  
  {  
    name: "greet",  
    description: "Greet someone by name",  
    inputSchema: {  
      type: "object",  
      properties: {  
        name: { type: "string", description: "Person's name" },  
      },  
      required: \["name"\],  
    },  
  },  
  {  
    name: "calculate\_age",  
    description: "Calculate age from birth year",  
    inputSchema: {  
      type: "object",  
      properties: {  
        birth\_year: {  
          type: "number",  
          description: "Year of birth",  
        },  
      },  
      required: \["birth\_year"\],  
    },  
  },  
  {  
    name: "format\_date",  
    description: "Format a date string",  
    inputSchema: {  
      type: "object",  
      properties: {  
        date: {  
          type: "string",  
          description: "ISO date string",  
        },  
        format: {  
          type: "string",  
          description: "Format (short, long, iso)",  
          enum: \["short", "long", "iso"\],  
        },  
      },  
      required: \["date", "format"\],  
    },  
  },  
\];

// Handle tool calls  
server.setRequestHandler(CallToolRequestSchema, async (request) \=\> {  
  const { name, arguments: args } \= request.params;

  try {  
    let result;

    switch (name) {  
      case "greet":  
        result \= \`Hello, ${args.name}\!\`;  
        break;

      case "calculate\_age":  
        const currentYear \= new Date().getFullYear();  
        const age \= currentYear \- args.birth\_year;  
        result \= \`Age: ${age} years old\`;  
        break;

      case "format\_date":  
        const date \= new Date(args.date);  
        if (args.format \=== "short") {  
          result \= date.toLocaleDateString();  
        } else if (args.format \=== "long") {  
          result \= date.toLocaleDateString("en-US", {  
            weekday: "long",  
            year: "numeric",  
            month: "long",  
            day: "numeric",  
          });  
        } else {  
          result \= date.toISOString();  
        }  
        break;

      default:  
        return {  
          content: \[{ type: "text", text: \`Unknown tool: ${name}\` }\],  
          isError: true,  
        };  
    }

    return {  
      content: \[{ type: "text", text: result }\],  
    };  
  } catch (error) {  
    return {  
      content: \[{ type: "text", text: \`Error: ${error.message}\` }\],  
      isError: true,  
    };  
  }  
});  
\`\`\`

\---

\#\# Creating a Python MCP Server

\#\#\# Step 1: Project Setup

\`\`\`bash  
mkdir my-mcp-server  
cd my-mcp-server  
pip install mcp  
\`\`\`

Create \`requirements.txt\`:

\`\`\`text  
mcp==1.0.0  
\`\`\`

\#\#\# Step 2: Create Server File

Create \`server.py\`:

\`\`\`python  
\#\!/usr/bin/env python3  
"""  
My Custom MCP Server  
"""

import asyncio  
import sys  
from mcp.server import Server  
from mcp.server.models import InitializationOptions  
from mcp.types import TextContent, Tool  
from mcp.server.stdio import stdio\_server

\# Create server instance  
server \= Server("my-mcp-server")

\# Define tools  
TOOLS: list\[Tool\] \= \[  
    Tool(  
        name="greet",  
        description="Greet someone by name",  
        inputSchema={  
            "type": "object",  
            "properties": {  
                "name": {  
                    "type": "string",  
                    "description": "Person's name",  
                },  
            },  
            "required": \["name"\],  
        },  
    ),  
\]

@server.list\_tools()  
async def handle\_list\_tools():  
    """Return list of available tools."""  
    return TOOLS

@server.call\_tool()  
async def handle\_call\_tool(name: str, arguments: dict) \-\> list\[TextContent\]:  
    """Handle tool calls."""  
    try:  
        if name \== "greet":  
            greeting \= f"Hello, {arguments\['name'\]}\!"  
            return \[TextContent(type="text", text=greeting)\]  
        else:  
            return \[TextContent(type="text", text=f"Unknown tool: {name}")\]  
    except Exception as error:  
        return \[TextContent(type="text", text=f"Error: {str(error)}")\]

async def main():  
    """Main entry point."""  
    from mcp import types

    print("MCP Server started ✅", file=sys.stderr, flush=True)

    async with stdio\_server() as (read\_stream, write\_stream):  
        init\_options \= InitializationOptions(  
            server\_name="my-mcp-server",  
            server\_version="1.0.0",  
            capabilities=types.ServerCapabilities(  
                tools=types.ToolsCapability(listChanged=False)  
            )  
        )

        await server.run(  
            read\_stream,  
            write\_stream,  
            init\_options  
        )

if \_\_name\_\_ \== "\_\_main\_\_":  
    asyncio.run(main())  
\`\`\`

\#\#\# Step 3: Add Multiple Tools (Python)

\`\`\`python  
TOOLS: list\[Tool\] \= \[  
    Tool(  
        name="greet",  
        description="Greet someone by name",  
        inputSchema={  
            "type": "object",  
            "properties": {  
                "name": {"type": "string", "description": "Person's name"},  
            },  
            "required": \["name"\],  
        },  
    ),  
    Tool(  
        name="calculate\_age",  
        description="Calculate age from birth year",  
        inputSchema={  
            "type": "object",  
            "properties": {  
                "birth\_year": {"type": "number", "description": "Year of birth"},  
            },  
            "required": \["birth\_year"\],  
        },  
    ),  
\]

@server.call\_tool()  
async def handle\_call\_tool(name: str, arguments: dict) \-\> list\[TextContent\]:  
    """Handle tool calls."""  
    try:  
        if name \== "greet":  
            result \= f"Hello, {arguments\['name'\]}\!"

        elif name \== "calculate\_age":  
            from datetime import datetime  
            current\_year \= datetime.now().year  
            age \= current\_year \- int(arguments\['birth\_year'\])  
            result \= f"Age: {age} years old"

        else:  
            return \[TextContent(type="text", text=f"Unknown tool: {name}")\]

        return \[TextContent(type="text", text=result)\]

    except Exception as error:  
        return \[TextContent(type="text", text=f"Error: {str(error)}")\]  
\`\`\`

\---

\#\# Testing Your MCP Server

\#\#\# Test Locally

\#\#\#\# Node.js

\`\`\`bash  
node index.js  
\# Should output: MCP Server started ✅  
\# Press Ctrl+C to stop  
\`\`\`

\#\#\#\# Python

\`\`\`bash  
python server.py  
\# Should output: MCP Server started ✅  
\# Press Ctrl+C to stop  
\`\`\`

\#\#\# Test with Echo

\#\#\#\# Node.js

\`\`\`bash  
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node index.js  
\`\`\`

\#\#\#\# Python

\`\`\`bash  
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python server.py  
\`\`\`

You should see a JSON response with your tools list.

\---

\#\# Adding to RICA

\#\#\# Step 1: Create MCP Block File

Create \`.rica/mcpServers/my-server.yaml\`:

\`\`\`yaml  
name: My MCP Server  
version: 1.0.0  
schema: v1  
mcpServers:  
  \- name: My Server  
    command: node \# or 'python' for Python servers  
    args:  
      \- /full/path/to/my-mcp-server/index.js  
    env: {}  
    connectionTimeout: 5000  
\`\`\`

\#\#\# Step 2: Test in RICA

1\. \*\*Restart RICA\*\* to load the new MCP server.  
2\. \*\*Switch to Agent Mode\*\* (\`Cmd/Ctrl \+ .\`).  
3\. \*\*Test your tool:\*\*

\`\`\`text  
Please greet John using the greet tool  
\`\`\`

4\. RICA should call your MCP server and return the result\! 🎉

\---

\#\# Connecting to Remote HTTP MCP Servers

\#\#\# Overview

Remote HTTP MCP servers (like Databricks-hosted servers) use HTTP transport instead of stdio. RICA currently supports stdio transport natively, so you need a \*\*proxy bridge\*\* to connect.

\*\*Example Remote MCP:\*\*

\`\`\`text  
https://mcp-server-hello-world-3862590836600123.3.azure.databricksapps.com/mcp  
\`\`\`

\#\#\# Solution: Create an HTTP-to-Stdio Bridge

Create a proxy script that:

1\. Receives stdio input from RICA  
2\. Forwards requests to HTTP MCP server  
3\. Returns responses via stdio

\#\#\# Node.js HTTP Bridge

Create \`mcp-http-bridge/index.js\`:

\`\`\`javascript  
\#\!/usr/bin/env node  
import fetch from 'node-fetch';  
import readline from 'readline';

const MCP\_URL \= process.env.MCP\_URL || process.argv\[2\];

if (\!MCP\_URL) {  
  console.error('Usage: node index.js \<MCP\_URL\>');  
  console.error('Or set MCP\_URL environment variable');  
  process.exit(1);  
}

console.error(\`HTTP MCP Bridge started → ${MCP\_URL}\`);

const rl \= readline.createInterface({  
  input: process.stdin,  
  output: process.stdout,  
  terminal: false  
});

rl.on('line', async (line) \=\> {  
  try {  
    const request \= JSON.parse(line);

    // Forward to HTTP MCP server  
    const response \= await fetch(MCP\_URL, {  
      method: 'POST',  
      headers: {  
        'Content-Type': 'application/json',  
      },  
      body: JSON.stringify(request)  
    });

    const data \= await response.json();  
    console.log(JSON.stringify(data));  
  } catch (error) {  
    console.error(\`Bridge error: ${error.message}\`);  
    console.log(JSON.stringify({  
      jsonrpc: '2.0',  
      error: {  
        code: \-32603,  
        message: error.message  
      },  
      id: null  
    }));  
  }  
});  
\`\`\`

\`package.json\`:

\`\`\`json  
{  
  "type": "module",  
  "dependencies": {  
    "node-fetch": "^3.3.0"  
  }  
}  
\`\`\`

Install:

\`\`\`bash  
npm install  
\`\`\`

\#\#\# Python HTTP Bridge

Create \`mcp-http-bridge/bridge.py\`:

\`\`\`python  
\#\!/usr/bin/env python3  
import sys  
import json  
import requests  
import os

MCP\_URL \= os.getenv('MCP\_URL') or (sys.argv\[1\] if len(sys.argv) \> 1 else None)

if not MCP\_URL:  
    print('Usage: python bridge.py \<MCP\_URL\>', file=sys.stderr)  
    print('Or set MCP\_URL environment variable', file=sys.stderr)  
    sys.exit(1)

print(f'HTTP MCP Bridge started → {MCP\_URL}', file=sys.stderr, flush=True)

for line in sys.stdin:  
    try:  
        request \= json.loads(line)

        \# Forward to HTTP MCP server  
        response \= requests.post(  
            MCP\_URL,  
            json=request,  
            headers={'Content-Type': 'application/json'}  
        )

        data \= response.json()  
        print(json.dumps(data), flush=True)

    except Exception as error:  
        print(f'Bridge error: {error}', file=sys.stderr, flush=True)  
        print(json.dumps({  
            'jsonrpc': '2.0',  
            'error': {  
                'code': \-32603,  
                'message': str(error)  
            },  
            'id': None  
        }), flush=True)  
\`\`\`

\`requirements.txt\`:

\`\`\`text  
requests==2.31.0  
\`\`\`

Install:

\`\`\`bash  
pip install \-r requirements.txt  
\`\`\`

\#\#\# Add Bridge to RICA Config

\#\#\#\# Option 1: Using Node.js Bridge

Create \`.rica/mcpServers/databricks-mcp.yaml\`:

\`\`\`yaml  
name: Databricks MCP  
version: 1.0.0  
schema: v1  
mcpServers:  
  \- name: Databricks Hello World  
    command: node  
    args:  
      \- /full/path/to/mcp-http-bridge/index.js  
      \- https://mcp-server-hello-world3862590836600123.3.azure.databricksapps.com/mcp  
    env: {}  
    connectionTimeout: 10000  
\`\`\`

\#\#\#\# Option 2: Using Python Bridge

\`\`\`yaml  
name: Databricks MCP  
version: 1.0.0  
schema: v1  
mcpServers:  
  \- name: Databricks Hello World  
    command: python  
    args:  
      \- /full/path/to/mcp-http-bridge/bridge.py  
      \- https://mcp-server-hello-world3862590836600123.3.azure.databricksapps.com/mcp  
    env: {}  
    connectionTimeout: 10000  
\`\`\`

\#\#\#\# Option 3: Using Environment Variable

\`\`\`yaml  
name: Databricks MCP  
version: 1.0.0  
schema: v1  
mcpServers:  
  \- name: Databricks Hello World  
    command: node  
    args:  
      \- /full/path/to/mcp-http-bridge/index.js  
    env:  
      MCP\_URL: https://mcp-server-hello-world3862590836600123.3.azure.databricksapps.com/mcp  
    connectionTimeout: 10000  
\`\`\`

\#\#\# Test the Bridge Locally

\#\#\#\# Test 1: Direct HTTP call

\`\`\`bash  
curl \-X POST https://mcp-server-hello-world3862590836600123.3.azure.databricksapps.com/mcp \\  
  \-H "Content-Type: application/json" \\  
  \-d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'  
\`\`\`

\#\#\#\# Test 2: Bridge via stdio

\`\`\`bash  
\# Node.js  
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \\  
  node index.js https://your-mcp-server.com/mcp

\# Python  
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \\  
  python bridge.py https://your-mcp-server.com/mcp  
\`\`\`

\#\#\# Authentication

If your remote MCP requires authentication:

\#\#\#\# Add API Key to Bridge: Node.js

\`\`\`javascript  
const API\_KEY \= process.env.API\_KEY;

const response \= await fetch(MCP\_URL, {  
  method: 'POST',  
  headers: {  
    'Content-Type': 'application/json',  
    'Authorization': \`Bearer ${API\_KEY}\`, // Add auth header  
  },  
  body: JSON.stringify(request)  
});  
\`\`\`

\#\#\#\# Python

\`\`\`python  
API\_KEY \= os.getenv('API\_KEY')

response \= requests.post(  
    MCP\_URL,  
    json=request,  
    headers={  
        'Content-Type': 'application/json',  
        'Authorization': f'Bearer {API\_KEY}', \# Add auth header  
    }  
)  
\`\`\`

\#\#\#\# RICA Config with Auth

\`\`\`yaml  
mcpServers:  
  \- name: Databricks MCP  
    command: node  
    args:  
      \- /full/path/to/bridge/index.js  
      \- https://your-mcp-server.com/mcp  
    env:  
      API\_KEY: ${{ secrets.DATABRICKS\_TOKEN }}  
    connectionTimeout: 10000  
\`\`\`

Store secret in \`.rica/.env\`:

\`\`\`env  
DATABRICKS\_TOKEN=your-token-here  
\`\`\`

\#\#\# Troubleshooting Remote MCP

\#\#\#\# Issue 1: Connection Timeout

\*\*Solutions:\*\*

\- Increase \`connectionTimeout\` to \`15000\`–\`30000ms\`  
\- Check if MCP server URL is accessible  
\- Verify network/firewall settings

\#\#\#\# Issue 2: Authentication Errors

\*\*Solutions:\*\*

\- Check API key is correct  
\- Verify token hasn't expired  
\- Check authorization header format

\#\#\#\# Issue 3: CORS Issues

If you see CORS errors, your bridge bypasses them since it's server-side.

\#\#\#\# Issue 4: Invalid JSON Responses

Debug bridge:

\`\`\`javascript  
// Add logging  
console.error(\`Request: ${JSON.stringify(request)}\`);  
console.error(\`Response: ${JSON.stringify(data)}\`);  
\`\`\`

\#\#\# Complete Example: Databricks MCP

\#\#\#\# 1\. Create bridge folder

\`\`\`bash  
mkdir mcp-databricks-bridge  
cd mcp-databricks-bridge  
\`\`\`

\#\#\#\# 2\. Create \`index.js\`

\`\`\`javascript  
\#\!/usr/bin/env node  
import fetch from 'node-fetch';  
import readline from 'readline';

const MCP\_URL \= 'https://mcp-server-hello-world3862590836600123.3.azure.databricksapps.com/mcp';

console.error(\`Databricks MCP Bridge started ✅\`);

const rl \= readline.createInterface({  
  input: process.stdin,  
  output: process.stdout,  
  terminal: false  
});

rl.on('line', async (line) \=\> {  
  try {  
    const request \= JSON.parse(line);

    const response \= await fetch(MCP\_URL, {  
      method: 'POST',  
      headers: { 'Content-Type': 'application/json' },  
      body: JSON.stringify(request)  
    });

    const data \= await response.json();  
    console.log(JSON.stringify(data));  
  } catch (error) {  
    console.error(\`Error: ${error.message}\`);  
  }  
});  
\`\`\`

\#\#\#\# 3\. Install dependencies

\`\`\`bash  
npm init \-y  
npm install node-fetch  
\`\`\`

\#\#\#\# 4\. Test

\`\`\`bash  
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node index.js  
\`\`\`

\#\#\#\# 5\. Add to RICA

\`.rica/mcpServers/databricks.yaml\`:

\`\`\`yaml  
name: Databricks MCP  
version: 1.0.0  
schema: v1  
mcpServers:  
  \- name: Databricks Hello World  
    command: node  
    args:  
      \- /full/path/to/mcp-databricks-bridge/index.js  
    env: {}  
    connectionTimeout: 15000  
\`\`\`

\#\#\#\# 6\. Restart RICA and test\!

\#\#\# Remote vs Local MCP Comparison

| Aspect | Local (Stdio) | Remote (HTTP) |  
|---|---|---|  
| Connection | Direct process spawn | HTTP bridge needed |  
| Latency | Low (\~1ms) | Higher (\~100–500ms) |  
| Setup | Simple | Requires bridge |  
| Scalability | Limited to local machine | Can scale horizontally |  
| Security | Local only | Network security needed |  
| Use Case | Development, local tools | Production, shared services |

\---

\#\# Best Practices

\#\#\# 1\. Tool Design

\#\#\#\# ✅ Good

\`\`\`javascript  
{  
  name: "search\_user",  
  description: "Search for a user by email or username",  
  inputSchema: {  
    type: "object",  
    properties: {  
      query: {  
        type: "string",  
        description: "Email or username to search for"  
      },  
      limit: {  
        type: "integer",  
        description: "Maximum results (1-100)",  
        minimum: 1,  
        maximum: 100  
      }  
    },  
    required: \["query"\]  
  }  
}  
\`\`\`

\#\#\#\# ❌ Bad

\`\`\`javascript  
{  
  name: "search", // Too generic  
  description: "Search", // Not descriptive  
  inputSchema: {  
    type: "object",  
    properties: {  
      q: { type: "string" } // Unclear parameter name  
    }  
  }  
}  
\`\`\`

\#\#\# 2\. Error Handling

Always handle errors gracefully:

\`\`\`javascript  
try {  
  const result \= await riskyOperation();  
  return {  
    content: \[{ type: "text", text: result }\]  
  };  
} catch (error) {  
  return {  
    content: \[{ type: "text", text: \`Error: ${error.message}\` }\],  
    isError: true  
  };  
}  
\`\`\`

\#\#\# 3\. Input Validation

Validate inputs before processing:

\`\`\`javascript  
if (name \=== "divide") {  
  if (args.divisor \=== 0\) {  
    return {  
      content: \[{ type: "text", text: "Error: Division by zero\!" }\],  
      isError: true  
    };  
  }  
  result \= args.dividend / args.divisor;  
}  
\`\`\`

\#\#\# 4\. Clear Descriptions

Write clear, helpful descriptions:

\`\`\`javascript  
{  
  name: "convert\_currency",  
  description: "Convert an amount from one currency to another using current exchange rates",  
  inputSchema: {  
    type: "object",  
    properties: {  
      amount: {  
        type: "number",  
        description: "Amount to convert (positive number)"  
      },  
      from\_currency: {  
        type: "string",  
        description: "Source currency code (e.g., USD, EUR, GBP)"  
      },  
      to\_currency: {  
        type: "string",  
        description: "Target currency code (e.g., USD, EUR, GBP)"  
      }  
    },  
    required: \["amount", "from\_currency", "to\_currency"\]  
  }  
}  
\`\`\`

\---

\#\# Common Patterns

\#\#\# Pattern 1: Database Query Tool

\`\`\`javascript  
{  
  name: "query\_database",  
  description: "Execute a SQL query on the database",  
  inputSchema: {  
    type: "object",  
    properties: {  
      query: { type: "string", description: "SQL query" },  
      database: {  
        type: "string",  
        enum: \["users", "products", "orders"\],  
        description: "Database to query"  
      }  
    },  
    required: \["query", "database"\]  
  }  
}  
\`\`\`

\#\#\# Pattern 2: File Operations Tool

\`\`\`javascript  
{  
  name: "read\_file",  
  description: "Read contents of a file",  
  inputSchema: {  
    type: "object",  
    properties: {  
      path: {  
        type: "string",  
        description: "File path (relative or absolute)"  
      },  
      encoding: {  
        type: "string",  
        enum: \["utf-8", "ascii", "base64"\],  
        description: "File encoding"  
      }  
    },  
    required: \["path"\]  
  }  
}  
\`\`\`

\#\#\# Pattern 3: API Client Tool

\`\`\`javascript  
{  
  name: "fetch\_data",  
  description: "Fetch data from an external API",  
  inputSchema: {  
    type: "object",  
    properties: {  
      url: {  
        type: "string",  
        description: "API endpoint URL"  
      },  
      method: {  
        type: "string",  
        enum: \["GET", "POST", "PUT", "DELETE"\],  
        description: "HTTP method"  
      },  
      headers: {  
        type: "object",  
        description: "Request headers (optional)"  
      },  
      body: {  
        type: "object",  
        description: "Request body (for POST/PUT)"  
      }  
    },  
    required: \["url", "method"\]  
  }  
}  
\`\`\`

\#\#\# Pattern 4: Validation Tool

\`\`\`javascript  
{  
  name: "validate\_email",  
  description: "Validate if a string is a valid email address",  
  inputSchema: {  
    type: "object",  
    properties: {  
      email: {  
        type: "string",  
        description: "Email address to validate"  
      }  
    },  
    required: \["email"\]  
  }  
}  
\`\`\`

\---

\#\# Troubleshooting

\#\#\# Issue 1: Server Not Starting

\*\*Symptoms:\*\* Server crashes immediately.

\*\*Solutions:\*\*

\- Check for syntax errors in your code  
\- Verify all dependencies are installed  
\- Check console output for error messages

\`\`\`bash  
\# Node.js  
node index.js 2\>&1 | tee error.log

\# Python  
python server.py 2\>&1 | tee error.log  
\`\`\`

\#\#\# Issue 2: RICA Can't Connect

\*\*Symptoms:\*\* Connection timeout in RICA.

\*\*Solutions:\*\*

\- Verify absolute path in YAML config  
\- Check command (\`node\`, \`python\`, etc.) is in \`PATH\`  
\- Increase \`connectionTimeout\` in config  
\- Test server locally first

\`\`\`yaml  
mcpServers:  
  \- name: My Server  
    command: node  
    args:  
      \- /full/absolute/path/to/index.js \# Must be absolute\!  
    connectionTimeout: 10000 \# Increase timeout  
\`\`\`

\#\#\# Issue 3: Tools Not Listed

\*\*Symptoms:\*\* RICA connects but no tools appear.

\*\*Solutions:\*\*

\- Check \`ListToolsRequestSchema\` handler returns tools array  
\- Verify tools array is not empty  
\- Check tool schema is valid JSON Schema

\`\`\`javascript  
// Debug: Log tools being returned  
server.setRequestHandler(ListToolsRequestSchema, async () \=\> {  
  console.error("Returning tools:", JSON.stringify(tools, null, 2));  
  return { tools };  
});  
\`\`\`

\#\#\# Issue 4: Tool Execution Fails

\*\*Symptoms:\*\* Tool calls return errors.

\*\*Solutions:\*\*

\- Add try-catch blocks around tool logic  
\- Validate arguments before use  
\- Return proper error responses  
\- Log execution for debugging

\`\`\`javascript  
server.setRequestHandler(CallToolRequestSchema, async (request) \=\> {  
  console.error("Tool call:", JSON.stringify(request.params));

  try {  
    // Your logic here  
  } catch (error) {  
    console.error("Error:", error);  
    return {  
      content: \[{ type: "text", text: \`Error: ${error.message}\` }\],  
      isError: true  
    };  
  }  
});  
\`\`\`

\---

\#\# Advanced Topics

\#\#\# Using Environment Variables

\`\`\`javascript  
// index.js  
const API\_KEY \= process.env.API\_KEY;

if (name \=== "fetch\_data") {  
  const response \= await fetch(args.url, {  
    headers: {  
      'Authorization': \`Bearer ${API\_KEY}\`  
    }  
  });  
  // ...  
}  
\`\`\`

Config:

\`\`\`yaml  
mcpServers:  
  \- name: My Server  
    command: node  
    args:  
      \- ./index.js  
    env:  
      API\_KEY: ${{ secrets.MY\_API\_KEY }}  
\`\`\`

\`.rica/.env\`:

\`\`\`env  
MY\_API\_KEY=your-secret-key  
\`\`\`

\#\#\# Async Operations

\#\#\#\# Node.js

\`\`\`javascript  
if (name \=== "fetch\_weather") {  
  const response \= await fetch(\`https://api.weather.com/${args.city}\`);  
  const data \= await response.json();  
  return {  
    content: \[{ type: "text", text: JSON.stringify(data) }\]  
  };  
}  
\`\`\`

\#\#\#\# Python

\`\`\`python  
@server.call\_tool()  
async def handle\_call\_tool(name: str, arguments: dict) \-\> list\[TextContent\]:  
    if name \== "fetch\_weather":  
        import aiohttp  
        async with aiohttp.ClientSession() as session:  
            async with session.get(f"https://api.weather.com/{arguments\['city'\]}") as response:  
                data \= await response.json()  
                return \[TextContent(type="text", text=str(data))\]  
\`\`\`

\---

\#\# Complete Example: Weather MCP Server

\#\#\# Node.js (\`weather-server/index.js\`)

\`\`\`javascript  
import { Server } from "@modelcontextprotocol/sdk/server/index.js";  
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";  
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server \= new Server({ name: "weather-mcp", version: "1.0.0" });

const tools \= \[  
  {  
    name: "get\_weather",  
    description: "Get current weather for a city",  
    inputSchema: {  
      type: "object",  
      properties: {  
        city: { type: "string", description: "City name" },  
        units: {  
          type: "string",  
          enum: \["metric", "imperial"\],  
          description: "Temperature units"  
        }  
      },  
      required: \["city"\]  
    }  
  }  
\];

server.setRequestHandler(ListToolsRequestSchema, async () \=\> ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) \=\> {  
  const { name, arguments: args } \= request.params;

  try {  
    if (name \=== "get\_weather") {  
      // Mock weather data (replace with real API)  
      const weather \= {  
        city: args.city,  
        temperature: 22,  
        units: args.units || "metric",  
        condition: "Sunny"  
      };

      return {  
        content: \[{  
          type: "text",  
          text: \`Weather in ${weather.city}: ${weather.temperature}° ${weather.units \=== "metric" ? "C" : "F"}, ${weather.condition}\`  
        }\]  
      };  
    }  
  } catch (error) {  
    return {  
      content: \[{ type: "text", text: \`Error: ${error.message}\` }\],  
      isError: true  
    };  
  }  
});

const transport \= new StdioServerTransport();  
await server.connect(transport);  
console.error("Weather MCP Server started ✅");  
\`\`\`

\---

\#\# Next Steps

\#\#\# 1\. Build Your Own

Start with a simple tool, then expand:

\- \*\*Beginner:\*\* String manipulation tool  
\- \*\*Intermediate:\*\* File system operations  
\- \*\*Advanced:\*\* Database connector or API client

\#\#\# 2\. Learn More

\- 📖 \[MCP Official Documentation\](https://modelcontextprotocol.io/)  
\- 📖 \[JSON Schema Reference\](https://json-schema.org/)  
\- 🔍 \[MCP Examples Repository\](https://github.com/modelcontextprotocol/servers)

\#\#\# 3\. Share Your Server

Consider publishing your MCP server:

\- GitHub repository  
\- npm package (Node.js)  
\- PyPI package (Python)  
\- RICA Hub (coming soon)

\---

\#\# Summary Checklist

\- \[ \] Understand MCP concepts (tools, schemas, transport)  
\- \[ \] Choose your language (Node.js or Python)  
\- \[ \] Set up project structure  
\- \[ \] Define tools with clear schemas  
\- \[ \] Implement tool handlers  
\- \[ \] Add error handling  
\- \[ \] Test locally  
\- \[ \] Create RICA config YAML  
\- \[ \] Test in RICA Agent Mode  
\- \[ \] Document your tools

\---

\*\*Congratulations\!\*\* You now know how to create custom MCP servers for RICA. Start building\! 🚀

