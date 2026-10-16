import { env } from "cloudflare:workers";

// failures are logged rather than thrown, so Slack being down doesn't stop the sync that's sending the message
export async function sendSlackMessage(text: string) {
  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      console.error(`Failed to send Slack message: ${response.status}`);
    }
  } catch (e) {
    console.error("Failed to send Slack message", e);
  }
}
