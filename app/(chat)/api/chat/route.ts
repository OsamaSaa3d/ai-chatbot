import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { queryPythonBackend } from '@/lib/ai/tools/query-python-backend';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';
import { getStreamContext } from '@/lib/stream-context';

export const maxDuration = 60;

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const {
      id,
      message,
      selectedChatModel,
      selectedVisibilityType,
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel['id'];
      selectedVisibilityType: VisibilityType;
    } = requestBody;

    console.log('Backend - Received entire message object:', JSON.stringify(message, null, 2));

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    // Temporarily disable message rate limiting for debugging
    // if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
    //   return new ChatSDKError('rate_limit:chat').toResponse();
    // }

    const chat = await getChatById({ id });

    let userMessage = '';
    const textPart = message.parts.find(
      (part) => part.type === 'text',
    ) as { text: string } | undefined;
    if (textPart) {
      userMessage = textPart.text;
    }

    if (!chat) {
      const title = userMessage.substring(0, 100) || 'New Chat'; // Use the correctly extracted userMessage
      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
    } else {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const messagesFromDb = await getMessagesByChatId({ id });
    const uiMessages = [...convertToUIMessages(messagesFromDb), message];

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        console.log('=== EXECUTE FUNCTION CALLED ===');
        // userMessage is already extracted at the higher scope

        if (!userMessage) {
          console.log('No user message, returning early');
          dataStream.write({
            type: 'data-textDelta',
            data: 'Please enter a message.',
            transient: true,
          });
          // The stream implicitly closes when execute finishes
          return;
        }

        try {
          console.log('Calling Python backend with message:', userMessage);

          // Type assertion to bypass the linter error, assuming the definition is correct
          const executePythonBackend = queryPythonBackend.execute as (
            args: { message: string },
          ) => Promise<string>;

          const pythonResponse = await executePythonBackend({
            message: userMessage,
          });
          console.log('Python backend response:', pythonResponse);

          dataStream.write({
            type: 'data-textDelta',
            data: pythonResponse,
            transient: true,
          });

          // Manually save the assistant message to the database
          console.log('Manually saving assistant message to database');
          
          // First, check if there's already an assistant message for this chat
          const existingMessages = await getMessagesByChatId({ id });
          const lastMessage = existingMessages[existingMessages.length - 1];
          
          if (lastMessage && lastMessage.role === 'assistant' && (lastMessage.parts as any[]).length === 0) {
            // Update the existing empty assistant message
            console.log('Updating existing empty assistant message:', lastMessage.id);
            await saveMessages({
              messages: [
                {
                  id: lastMessage.id,
                  role: 'assistant',
                  parts: [{ type: 'text', text: pythonResponse }],
                  createdAt: lastMessage.createdAt,
                  attachments: [],
                  chatId: id,
                },
              ],
            });
          } else {
            // Create a new assistant message
            console.log('Creating new assistant message');
            await saveMessages({
              messages: [
                {
                  id: generateUUID(),
                  role: 'assistant',
                  parts: [{ type: 'text', text: pythonResponse }],
                  createdAt: new Date(),
                  attachments: [],
                  chatId: id,
                },
              ],
            });
          }

          // The stream implicitly closes when execute finishes
        } catch (error) {
          console.error('Error calling Python backend:', error);
          const errorMessage = 'Error connecting to the Python backend.';
          
          dataStream.write({
            type: 'data-textDelta',
            data: errorMessage,
            transient: true,
          });

          // Manually save the error message to the database
          console.log('Manually saving error message to database');
          
          // First, check if there's already an assistant message for this chat
          const existingMessages = await getMessagesByChatId({ id });
          const lastMessage = existingMessages[existingMessages.length - 1];
          
          if (lastMessage && lastMessage.role === 'assistant' && (lastMessage.parts as any[]).length === 0) {
            // Update the existing empty assistant message
            console.log('Updating existing empty assistant message with error:', lastMessage.id);
            await saveMessages({
              messages: [
                {
                  id: lastMessage.id,
                  role: 'assistant',
                  parts: [{ type: 'text', text: errorMessage }],
                  createdAt: lastMessage.createdAt,
                  attachments: [],
                  chatId: id,
                },
              ],
            });
          } else {
            // Create a new assistant message
            console.log('Creating new assistant error message');
            await saveMessages({
              messages: [
                {
                  id: generateUUID(),
                  role: 'assistant',
                  parts: [{ type: 'text', text: errorMessage }],
                  createdAt: new Date(),
                  attachments: [],
                  chatId: id,
                },
              ],
            });
          }
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages }) => {
        console.log('onFinish - Messages before saving:', JSON.stringify(messages, null, 2));
        // Do not save any messages here since we're handling them manually
        console.log('onFinish - Skipping save since messages are handled manually');
      },
      onError: (error) => {
        // This onError will catch the re-thrown error from execute
        console.error('Stream error caught by onError:', error);
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
    } else {
      return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    console.error('Unhandled error in chat API:', error);
    return new ChatSDKError('offline:chat').toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
