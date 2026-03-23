exports.handler = async function(event, context) {
  const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR2DGzKBJpSVRqYLd7AGNxXDetNsmrboUDIyqAv0OCu8lF5L0l58NFfYiCZVtrOkkSFFCMGACIH0Ojh/pub?gid=811045373&single=true&output=csv';

  try {
    const response = await fetch(CSV_URL);
    const text = await response.text();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300', // cache 5 min
      },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
