# Image Processing Feature Guide

## Overview
This chatbot now supports advanced image processing with OCR (Optical Character Recognition) and automatic diagram extraction.

## How It Works

### 🔒 Internal Processing (Backend)

When a user uploads an image and types a message like "explain the image please":

1. **OCR Text Extraction**
   - Extracts question text from the uploaded image using Tesseract.js
   - Removes the question text from processing
   
2. **Diagram Extraction**
   - Detects and extracts ONLY the diagram/illustration part
   - Includes: blocks, arrows, force directions, ground lines, angles
   - Excludes: question text, options (A, B, C, D), UI borders, headers, backgrounds
   
3. **AI Analysis**
   - Uses OpenAI Vision API to analyze the extracted diagram
   - Generates appropriate educational response

### 🧑‍💻 User Interface Behavior (Frontend)

#### ✅ User Message Bubble
- Does NOT display raw user text like "explain the image please"
- Displays ONLY the extracted question text (from OCR)
- Clean, professional appearance

#### 🤖 Bot Response Bubble
- Displays the extracted diagram image (NOT the full uploaded image)
- Shows only the cropped diagram without text, options, or UI elements
- Provides explanation based on the diagram

## Strict Rules Implementation

✅ **DO:**
- Show extracted question as user message
- Show only the cropped diagram in bot response
- Keep clear separation between user input and extracted content

❌ **DON'T:**
- Show the full uploaded image
- Mix user input with extracted content
- Display "explain the image please" in chat
- Show text, options, or UI elements in the diagram

## Technical Stack

- **OCR**: Tesseract.js
- **Image Processing**: Sharp
- **Canvas Operations**: node-canvas
- **Vision AI**: OpenAI GPT-4o-mini with Vision

## API Response Structure

When an image is uploaded, the API returns:

```json
{
  "success": true,
  "response": "AI generated response...",
  "extractedQuestion": "Question text extracted by OCR",
  "diagramImage": "data:image/png;base64,...",
  "isNewTopic": true/false,
  "questionCount": 1,
  "topic": "Physics"
}
```

## Usage Example

1. User uploads an image containing a physics problem with a diagram
2. User types: "explain the image please"
3. System extracts:
   - Question text: "If a child is dragging his 2 kg toy..."
   - Diagram: [Force diagram with arrows and blocks]
4. UI displays:
   - User bubble: Shows extracted question text
   - Bot bubble: Shows extracted diagram + explanation

## Files Modified

1. **server.js**
   - Added OCR extraction function
   - Added diagram extraction function
   - Updated `/api/tutor/ask` endpoint

2. **public/index.html**
   - Updated `askQuestion()` function
   - Modified `addMessage()` function
   - Enhanced message display logic

## Testing

To test the feature:
1. Start the server: `npm start`
2. Open http://localhost:3000
3. Upload an image with text and a diagram
4. Type "explain the image please" or similar
5. Observe the extracted question and diagram

## Notes

- OCR accuracy depends on image quality
- Diagram extraction uses grid-based analysis
- Fallback to original image if extraction fails
- Supports PNG, JPG, and other common formats
