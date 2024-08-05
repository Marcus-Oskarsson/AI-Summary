import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

export const config = {
  runtime: "edge",
};

const OMNIVORE_URL = "https://api-prod.omnivore.app/api/graphql";

class AI {
  constructor(model = null, settings = null) {
    this.openai = new OpenAI();
    this.model = model || process.env["OPENAI_MODEL"] || "gpt-4o-mini";
    this.settings = settings || process.env["OPENAI_SETTINGS"] || `{"model":"${this.model}", "temperature":0.5}`;
  }

  async getCompletion(prompt, articleContent) {
    console.log(`Getting completion for prompt: ${prompt}`);
    if (!prompt || !articleContent) {
      return new Response("Prompt and article content are required.", { status: 400 });
    }

    try {
      const completion = await this.openai.chat.completions.create({
        ...JSON.parse(this.settings),
        messages: [
          {
            role: "user",
            content: `Instruction: ${prompt}\nArticle content: ${articleContent}`,
          },
        ],
      });

      if (completion.choices.length <= 0 || completion.choices[0]?.message?.content === "") {
        throw new Error(`No completion returned from OpenAI for prompt "${prompt}"`);
      }
      console.log(`Completion received: ${trimAnnotation(completion.choices[0].message.content)}`);
      return trimAnnotation(completion.choices[0].message.content);
    } catch (error) {
      console.error(`Error fetching completion from OpenAI: ${error.message}`);
      return new Response(
        `Error fetching completion from OpenAI: ${error.message}`,
        { status: 500 }
      );
    }
  }

  async getBestCompletionOutOf(prompt, completions, articleContent) {
    console.log(`Getting best completion for prompt: ${prompt}`);
    if (!prompt || !completions || completions.length <= 0 || !articleContent) {
      throw new Error("Prompt, completions, and article content are required.");
    }
  
    const completionContents = await Promise.all(
      completions.map(() => this.getCompletion(prompt, articleContent))
    );
    console.log(`Array Completions received: ${completionContents.join("\n")}`);
  
    return await this.getCompletion(
      "Review the following completions and select and refine the best one based upon the clarity, Obsidian compatibility, and actionability. Dont add new headings or any text marking it's a refined version of the completion.",
      completionContents.join("\n")
    );
  }
}

class Omnivore {
  constructor() {
    this.apiKey = process.env["OMNIVORE_API_KEY"];
    if (!this.apiKey) {
      throw new Error("API key is not defined");
    }
    this.headers = {
      "Content-Type": "application/json",
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
    console.log("GET ARTICLE QUERY: ", query);

    try {
      const response = await fetch(OMNIVORE_URL, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ query }),
        redirect: "follow",
      });

      console.log("RESPONSE: ", response);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log("DATA: ", data);
      if (data.errors) {
        throw new Error(`GraphQL error: ${data.errors.map(e => e.message).join(", ")}`);
      }

      if (!data?.data?.article?.article?.content && attempts < 3) {
        const delay = Math.pow(2, attempts) * 1000;
        console.log(`No response, retrying... Attempt ${attempts + 1}`);
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(this.getArticle(articleId, attempts + 1));
          }, delay);
        });
      }

      console.log("ARTICLE CONTENT: ", data.data.article.article.content);
      return data.data.article.article.content;
    } catch (error) {
      console.error(`Error fetching article from Omnivore: ${error.message}`);
      return new Response(
        `Error fetching article from Omnivore: ${error.message}`,
        { status: 500 }
      );
    }
  }

  async addAnnotation(articleId, annotation) {
    console.log(`Adding annotation to article (ID: ${articleId}): ${annotation}`);
    const id = uuidv4();
    const query = {
      query: this.buildPostQuery(),
      variables: {
        input: {
          type: "NOTE",
          id,
          shortId: id.substring(0, 8),
          articleId,
          annotation,
        },
      },
    };
    console.log("ADD ANNOTATION QUERY: ", query);

    try {
      const response = await fetch(OMNIVORE_URL, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(query),
        redirect: "follow",
      });

      if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log("DATA: ", data);
      if (data.errors) {
        console.error(`GraphQL error: ${data.errors.map(e => e.message).join(", ")}`);
        throw new Error(`GraphQL error: ${data.errors.map(e => e.message).join(", ")}`);
      }

      console.log("ANNOTATION ADDED: ", data.data.createHighlight);
      return data.data.createHighlight;
    } catch (error) {
      console.error(`Error adding annotation to Omnivore article (ID: ${articleId}): ${error.message}`);
      return new Response(
        `Error adding annotation to Omnivore article (ID: ${articleId}): ${error.message}`,
        { status: 500 }
      );
    }
  }
}

function trimAnnotation(annotation) {
  return annotation.trim().replace(/"/g, '\\"').replace(/\\/g, "\\\\");
}

export default async (req) => {
  console.log("STARTING ANNOTATION");
  let body;
  try {
    body = await req.json();
  } catch (e) {
    console.error(`No payload found: ${e.message}`);
    return new Response("No payload found.", { status: 400 });
  }

  const { page: pageCreated } = body;
  const articleId = pageCreated.id;

  console.log(`Article ID: ${articleId}`);

  const omnivore = new Omnivore();
  const article = await omnivore.getArticle(articleId);

  console.log(`Article content received: ${article}`);

  const ai = new AI();
  const articleAnnotation = await ai.getBestCompletionOutOf(process.env["OPENAI_PROMPT"], [...Array(3).keys()], article);;
  const response = await omnivore.addAnnotation(articleId, articleAnnotation);
  console.log(`Article annotation added: ${response}`);

  return new Response(`Article annotation added.`);
};