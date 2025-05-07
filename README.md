# Interacting with the Drug Gene Interaction Database (DGIdb) via Claude Desktop

This guide helps scientists and researchers use the Drug Gene Interaction Database (DGIdb) through an application called Claude Desktop. This setup allows you to ask questions about drug-gene interactions in plain language and get results directly within Claude.

## What is this?

*   **DGIdb:** A comprehensive database containing information about how drugs interact with genes. It gathers data from many different sources.
*   **MCP Server:** A piece of software that acts as a bridge. This specific server connects to the DGIdb API. "MCP" stands for Model Context Protocol, a way for AI models (like the one in Claude) to use tools.
*   **Claude Desktop:** An application where you can interact with an AI assistant. By configuring it correctly, Claude can use this MCP Server to fetch data from DGIdb for you.

Essentially, this server gives Claude the "tool" it needs to look up information in the DGIdb.

## How to Use This with Claude Desktop

If this DGIdb MCP Server has been set up and deployed (e.g., by a technical colleague), you can connect your Claude Desktop application to it. This allows you to ask Claude questions like:

*   "What are the interactions for the drug Imatinib?"
*   "Find genes that interact with Dovitinib."
*   "Show me drug attributes for Trametinib."

Claude will then use this server to find the answers in the DGIdb and present them to you.

### Configuration for Claude Desktop

Your Claude Desktop application needs to be told where to find this DGIdb server. This is usually done by editing a configuration file for Claude Desktop.

A technical user or administrator would typically handle the deployment of the server and provide you with a specific URL (web address). For example, the server might be available at an address like: `https://dgidb-mcp-server.your-organization.workers.dev/sse`.

The configuration in Claude Desktop would then look something like this. You would add the "dgidb" section within the `mcpServers` part of your Claude Desktop configuration file:

```json
{
  "mcpServers": {
    // ... (other server configurations might be here) ...

    "dgidb": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://dgidb-mcp-server.quentincody.workers.dev/sse" // <-- This URL needs to be the actual address of YOUR deployed DGIdb MCP server
      ]
    }

    // ... (other server configurations might be here) ...
  }
}
```

**Important:**
*   The URL `https://dgidb-mcp-server.quentincody.workers.dev/sse` in the example above is illustrative. You will need to replace it with the actual URL where *your* instance of the DGIdb MCP server is running.
*   After updating the configuration, you usually need to restart Claude Desktop for the changes to take effect.

Once configured, the DGIdb tool should become available within Claude, allowing you to query the database easily.

## For Technical Users: Deploying the Server

If you are a technical user and need to deploy this server (e.g., on Cloudflare Workers):

1.  **Get Started:**
    You can deploy this server to Cloudflare Workers. Refer to the original, more technical README for deployment buttons and command-line instructions (often involving `npm create cloudflare@latest`).

2.  **Customization:**
    The server code is in `src/index.ts`. This file defines how the server connects to DGIdb and what "tools" it provides to MCP clients.

3.  **Connecting to Other Clients (like AI Playground):**
    Once deployed, you can also connect to your MCP server from other clients like the Cloudflare AI Playground by providing its URL (e.g., `https://your-dgidb-server-name.your-account.workers.dev/sse`).

This DGIdb MCP Server uses the publicly available DGIdb GraphQL API at `https://dgidb.org/api/graphql`.
