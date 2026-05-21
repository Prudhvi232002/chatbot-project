# API Documentation - NEET Tutor Chatbot

## Simple Q&A Endpoint

### POST `/api/answer`

Simple question-answer API that accepts a question with optional image URL and returns an AI-generated response.

#### Request Format

```json
{
  "question": "string (required) - Your question with answer options",
  "image": "string or null (optional) - Image URL or null"
}
```

#### Response Format

```json
{
  "success": true,
  "response": "string - AI generated response"
}
```

#### Example Usage

##### cURL Example

```bash
curl -X POST http://localhost:3000/api/answer \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is acceleration? A) Rate of change of velocity B) Rate of change of distance C) Rate of change of time D) None",
    "image": null
  }'
```

##### JavaScript Fetch Example

```javascript
const response = await fetch('http://localhost:3000/api/answer', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    question: 'What is photosynthesis? A) Process of making food B) Process of breathing C) Process of digestion D) None',
    image: null
  })
});

const data = await response.json();
console.log(data.response);
```

##### Python Example

```python
import requests
import json

url = "http://localhost:3000/api/answer"
payload = {
    "question": "What is the SI unit of pressure? A) Pascal B) Newton C) Joule D) Watt",
    "image": None
}

response = requests.post(url, json=payload)
data = response.json()

if data['success']:
    print(data['response'])
else:
    print(f"Error: {data['error']}")
```

##### With Image URL

```bash
curl -X POST http://localhost:3000/api/answer \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Explain this diagram",
    "image": "https://example.com/physics-diagram.jpg"
  }'
```

---

## Full Tutor API Endpoints

### POST `/api/tutor/ask`

Full-featured tutoring endpoint with session management and image analysis.

#### Request Format

```json
{
  "studentId": "string (required) - Unique student identifier",
  "question": "string (optional if image provided) - Student question",
  "image": "string (optional) - Base64 encoded image",
  "isEdit": "boolean (optional) - Whether this is an edited question"
}
```

#### Response Format

```json
{
  "success": true,
  "response": "string - AI tutor response",
  "isNewTopic": "boolean - Whether this is a new topic",
  "questionCount": "number - Total questions asked",
  "previousQuestion": "string - Last question asked",
  "topic": "string - Current topic",
  "extractedQuestion": "string (optional) - OCR extracted text from image",
  "diagramImage": "string (optional) - Extracted diagram as base64",
  "timestamp": "string - ISO timestamp"
}
```

#### Example

```javascript
const response = await fetch('http://localhost:3000/api/tutor/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    studentId: 'student_abc123',
    question: 'What is Newton\'s first law?',
    isEdit: false
  })
});

const data = await response.json();
console.log(data.response);
```

---

### GET `/api/tutor/history/:studentId`

Get the complete chat history for a student.

#### Response Format

```json
{
  "success": true,
  "history": [
    {
      "role": "user",
      "content": "What is acceleration?",
      "timestamp": "2025-12-19T10:30:00.000Z"
    },
    {
      "role": "assistant",
      "content": "📚 Concept: Acceleration...",
      "timestamp": "2025-12-19T10:30:02.000Z"
    }
  ]
}
```

#### Example

```bash
curl http://localhost:3000/api/tutor/history/student_abc123
```

---

### POST `/api/tutor/clear`

Clear a student's session and chat history.

#### Request Format

```json
{
  "studentId": "string (required) - Student ID to clear"
}
```

#### Response Format

```json
{
  "success": true,
  "message": "Session cleared"
}
```

#### Example

```bash
curl -X POST http://localhost:3000/api/tutor/clear \
  -H "Content-Type: application/json" \
  -d '{"studentId": "student_abc123"}'
```

---

### GET `/api/tutor/session/:studentId`

Get current session information for a student.

#### Response Format

```json
{
  "success": true,
  "session": {
    "previousQuestion": "string - Last question asked",
    "currentTopic": "string - Current topic",
    "questionCount": "number - Total questions",
    "historyLength": "number - Total messages in history"
  }
}
```

#### Example

```bash
curl http://localhost:3000/api/tutor/session/student_abc123
```

---

### POST `/api/tutor/debug/words`

Debug endpoint to extract keywords and topic from a question.

#### Request Format

```json
{
  "question": "string (required) - Question to analyze"
}
```

#### Response Format

```json
{
  "success": true,
  "question": "string - Original question",
  "extractedWords": ["array", "of", "keywords"],
  "wordCount": "number - Total keywords",
  "detectedTopic": "string - Detected topic"
}
```

---

## Testing

Run the test script:

```bash
node test-api.js
```

Or visit the documentation endpoint:

```bash
curl http://localhost:3000/api/answer
```

---

## Server Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with your OpenAI API key:
```
OPENAI_API_KEY=your_api_key_here
```

3. Start the server:
```bash
node server.js
```

4. Access the web interface:
```
http://localhost:3000
```

---

## Response Format Details

The AI tutor uses a special **4-section format** for the FIRST question on a NEW topic:

```
📚 Concept: [Topic Name]

🌟 Core Concept:
[Main concept explanation]

✨ Helpful Hint:
[Guiding hint without direct answer]

💬 Final Point:
[Thought-provoking question to engage student]
```

For **follow-up questions** on the same topic, the tutor provides shorter, direct answers.

---

## Image Processing

When an image is uploaded:
1. **OCR Extraction**: Tesseract.js extracts text from the image
2. **Diagram Extraction**: Canvas API isolates diagrams/illustrations
3. **Vision Analysis**: OpenAI Vision API analyzes the diagram
4. **Combined Response**: Text + image analysis = comprehensive answer

Supported image formats: JPG, PNG, WebP, GIF

---

## Error Handling

All endpoints return consistent error format:

```json
{
  "success": false,
  "error": "Error message description"
}
```

Common error codes:
- `400`: Bad Request (missing required fields)
- `500`: Internal Server Error

---

## Rate Limiting

No rate limiting is currently implemented. Consider adding rate limiting for production use.

---

## Support

For issues or questions, check the server logs or contact support.
