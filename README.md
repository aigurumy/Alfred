# Alfred

AI-powered desktop assistant that helps you write reports by typing directly into Microsoft Word.

## Features

- 🤖 AI-powered content generation using OpenAI
- ⌨️ Types directly into Microsoft Word using COM automation
- 🪟 Windows-native integration
- ⚡ Real-time typing effect

## Requirements

- **Windows OS** (required for COM automation)
- **Microsoft Word** installed and running
- **OpenRouter API Key** (pre-configured, or get one at https://openrouter.ai/keys)
- **Node.js** (for development)

## Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```

## Usage

1. **Start the application:**
```bash
npm run dev
```

2. **Open Microsoft Word** (must be running)

3. **API key is pre-configured** (or enter your own OpenRouter API key if you want to use a different one)

4. **Type your writing request**, for example:
   - "Write an introduction about artificial intelligence"
   - "Write a conclusion about climate change"
   - "Write 3 paragraphs about renewable energy"

5. **Click "Generate & Type"**

6. Watch as the AI generates content and types it directly into your Word document!

## How It Works

1. You enter a writing request
2. The app sends it to OpenRouter API (using GPT-4)
3. AI generates professional content
4. The app uses Windows COM automation to type the content character-by-character into your active Word document

## Technical Details

- Built with **Electron** for desktop app
- Uses **OpenRouter API** (GPT-4) for content generation
- Uses **VBScript COM automation** for reliable Word control
- Falls back to PowerShell if VBScript fails

## Troubleshooting

### Word is not detected
- Make sure Microsoft Word is installed
- Make sure Word is running (open it first)
- Click "Check Word" button to verify

### Typing doesn't work
- Ensure Word window is active
- Try creating a new document in Word
- Check that Word is not in protected view

### API Key errors
- Default OpenRouter API key is pre-configured
- If using your own key, verify it's correct at https://openrouter.ai/keys
- Make sure you have API credits
- Check your internet connection

## Development

```bash
# Run in development mode
npm run dev

# Build for production
npm run build
```

## License

MIT
