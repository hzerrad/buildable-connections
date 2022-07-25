const axios = require("axios");

const run = async (input) => {
  const { BUILDABLE_SLACK_ACCESS_TOKEN, event_context, cursor, limit } = input;

  verifyInput(input);

  try {
    const { data } = await axios({
      method: "get",
      url: "https://slack.com/api/apps.event.authorizations.list",
      headers: { Authorization: `Bearer ${BUILDABLE_SLACK_ACCESS_TOKEN}` },
      params: { event_context, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) },
    });

    return data;
  } catch (error) {
    return {
      failed: true,
      message: error.message,
      data: error.response.data,
    };
  }
};

/**
 * Verifies the input parameters
 */
const verifyInput = ({ BUILDABLE_SLACK_ACCESS_TOKEN, event_context }) => {
  const ERRORS = {
    INVALID_BUILDABLE_SLACK_ACCESS_TOKEN:
      "A valid BUILDABLE_SLACK_ACCESS_TOKEN field (string) was not provided in the input.",
    INVALID_EVENT_CONTEXT: "A valid event_context field (string) was not provided in the input.",
  };

  if (typeof BUILDABLE_SLACK_ACCESS_TOKEN !== "string")
    throw new Error(ERRORS.INVALID_BUILDABLE_SLACK_ACCESS_TOKEN);
  if (typeof event_context !== "string") throw new Error(ERRORS.INVALID_EVENT_CONTEXT);
};
