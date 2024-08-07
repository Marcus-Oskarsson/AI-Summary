import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

export const config = {
  runtime: 'edge',
};

const OMNIVORE_URL = 'https://api-prod.omnivore.app/api/graphql';
const PROMPT = `List actionable tasks based on the article's lessons or explain how the content can impact my life, productivity, or learning if tasks are not applicable.`;

const REFINEMENT_PROMPT = `Review the following completions. Select and refine the best one for clarity and Obsidian compatibility. Do not add new headings or indicate it has been refined, and do not shorten or remove text - just fix errors and make it more compatible with Obsidian.`;

class AI {
  constructor(model = null, settings = null) {
    this.openai = new OpenAI();
    this.model = model || process.env['OPENAI_MODEL'] || 'gpt-4o-mini';
    this.settings =
      settings ||
      process.env['OPENAI_SETTINGS'] ||
      `{"model":"${this.model}", "temperature":0.5}`;
  }

  async getCompletion(prompt, articleContent) {
    if (!prompt || !articleContent) {
      console.error('Prompt and article content are required.');
    }

    try {
      const completion = await this.openai.chat.completions.create({
        ...JSON.parse(this.settings),
        messages: [
          {
            role: 'user',
            content: `Instruction: ${prompt}\nArticle content: ${articleContent}`,
          },
        ],
      });

      if (
        completion.choices.length <= 0 ||
        completion.choices[0]?.message?.content === ''
      ) {
        throw new Error(
          `No completion returned from OpenAI for prompt "${prompt}"`,
        );
      }
      return trimAnnotation(completion.choices[0].message.content);
    } catch (error) {
      console.error(`Error fetching completion from OpenAI: ${error.message}`);
    }
  }

  async getBestCompletionOutOf(prompt, completions, articleContent) {
    if (!prompt || !completions || completions.length <= 0 || !articleContent) {
      throw new Error('Prompt, completions, and article content are required.');
    }

    const completionContents = await Promise.all(
      completions.map(() => this.getCompletion(prompt, articleContent)),
    );

    return await this.getCompletion(
      REFINEMENT_PROMPT,
      completionContents.join('\n'),
    );
  }
}

class Omnivore {
  constructor() {
    this.apiKey = process.env['OMNIVORE_API_KEY'];
    if (!this.apiKey) {
      throw new Error('API key is not defined');
    }
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: this.apiKey,
    };
  }

  buildGetQuery(articleId) {
    return `query Article {
      article(
        slug: "${articleId}"
        username: "."
        format: "markdown"
        ) {
          ... on ArticleSuccess {
            article {
              title
              content
              labels {
                name
              }
            }
          }
        }
      }`;
  }

  buildPostQuery() {
    return `mutation CreateHighlight($input: CreateHighlightInput!) {
      createHighlight(input: $input) {
        ... on CreateHighlightSuccess {
          highlight {
            ...HighlightFields
          }
        }

        ... on CreateHighlightError {
          errorCodes
        }
      }
    }

    fragment HighlightFields on Highlight {
      id
      type
      shortId
      quote
      prefix
      suffix
      patch
      color
      annotation
      createdByMe
      createdAt
      updatedAt
      sharedAt
      highlightPositionPercent
      highlightPositionAnchorIndex
      labels {
        id
        name
        color
        createdAt
      }
    }`;
  }

  async getArticle(articleId, attempts = 0) {
    const query = this.buildGetQuery(articleId);

    try {
      const response = await fetch(OMNIVORE_URL, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query }),
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.errors) {
        throw new Error(
          `GraphQL error: ${data.errors.map((e) => e.message).join(', ')}`,
        );
      }

      if (!data?.data?.article?.article?.content && attempts < 3) {
        const delay = Math.pow(2, attempts) * 1000;
        console.error(`No response, retrying... Attempt ${attempts + 1}`);
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(this.getArticle(articleId, attempts + 1));
          }, delay);
        });
      }

      return data.data.article.article.content;
    } catch (error) {
      console.error(`Error fetching article from Omnivore: ${error.message}`);
    }
  }

  async addAnnotation(articleId, annotation, id) {
    // const id = uuidv4();
    const query = {
      query: this.buildPostQuery(),
      variables: {
        input: {
          type: 'NOTE',
          id,
          shortId: id.substring(0, 8),
          articleId,
          annotation,
        },
      },
    };

    try {
      const response = await fetch(OMNIVORE_URL, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(query),
        redirect: 'follow',
      });

      if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.errors) {
        console.error(
          `GraphQL error: ${data.errors.map((e) => e.message).join(', ')}`,
        );
        throw new Error(
          `GraphQL error: ${data.errors.map((e) => e.message).join(', ')}`,
        );
      }

      return data.data.createHighlight;
    } catch (error) {
      console.error(
        `Error adding annotation to Omnivore article (ID: ${articleId}): ${error.message}`,
      );
    }
  }
}

function trimAnnotation(annotation) {
  return annotation.trim().replace(/"/g, '\\"').replace(/\\/g, '\\\\');
}

export default async (req) => {
  console.log('STARTING ACTION ANNOTATION');
  let body;
  try {
    body = await req.json();
  } catch (e) {
    console.error(`No payload found: ${e.message}`);
  }

  const { articleId } = body;
  const { article } = body;
  let { articleAnnotation } = body;
  const { id } = body;
  console.log("ID: ", id);


  const omnivore = new Omnivore();
  const ai = new AI();
  // articleAnnotation +=
  //   '\n##Actions\n' + (await ai.getCompletion(PROMPT, article));
  // const response = await omnivore.addAnnotation(articleId, articleAnnotation);

  const response = await omnivore.addAnnotation(
    articleId,
    'En Action till artikeln',
  );
  await fetch('https://ai-summary-theta.vercel.app/api/repetition', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      articleId,
      article,
      articleAnnotation: '',
      id
    }),
  });

  return new Response(JSON.stringify(response), { status: 200 });
};
