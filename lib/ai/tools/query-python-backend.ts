import { tool } from 'ai';
import { z } from 'zod';

export const queryPythonBackend = tool({
  description: 'Query the python backend with a message.',
  inputSchema: z.object({
    message: z.string().describe('The message to send to the backend.'),
  }),
  execute: async ({ message }) => {
    try {
        console.log("Sending to Python backend:", message);
      const response = await fetch('http://192.168.66.1:5000/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      // Return the response from the Python server so the AI can process it.
      return data.response;
    } catch (error) {
      console.error('Error querying Python backend:', error);
      return 'Error connecting to the Python backend.';
    }
  },
});
