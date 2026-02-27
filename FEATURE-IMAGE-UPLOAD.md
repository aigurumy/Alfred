# Image Upload & Word Integration Feature

## Overview
Allow users to send images to the AI when writing reports, and have the AI add pictures to the report with proper arrangement in Microsoft Word.

## Technical Feasibility
✅ **Yes, this is technologically possible**

### 1. Image Upload & Processing
- Add file input or drag-and-drop in the UI
- Users can select images (JPG, PNG, etc.)
- Images are sent to the AI along with the text prompt

### 2. AI Vision Capabilities
- Claude Sonnet 4.5 supports vision (image understanding)
- Can analyze images, describe content, and suggest placement
- Can generate text that references the images

### 3. Word Document Integration
- VBScript/COM can insert images into Word documents
- Capabilities:
  - Insert images at specific positions
  - Resize images
  - Add captions
  - Control layout (inline, wrapped, positioned)

### 4. AI-Driven Layout
- The AI can decide:
  - Where to place each image (before/after sections, inline, etc.)
  - Image sizing
  - Caption text
  - Wrapping style

## Implementation Approach

### Phase 1: UI
- Add image upload button/area in the chat interface
- Support drag-and-drop
- Show preview of uploaded images
- Allow multiple images per message

### Phase 2: Backend
- Send images as base64 to Claude (vision API)
- Handle image compression/resizing if needed
- Store images temporarily for Word insertion

### Phase 3: AI Integration
- Include images in Claude API calls (vision support)
- AI response includes image placement instructions
- Parse structured instructions for Word automation

### Phase 4: Word Automation
- Parse AI's image placement instructions
- Insert images at specified locations
- Apply formatting (size, wrapping, captions)
- Handle image file paths/temporary storage

## Example Flow

1. **User**: "Write a report about climate change and add this image [uploads image]"
2. **AI**: Analyzes image, generates report, specifies where to place it
3. **Word**: Inserts the image at the specified location with proper formatting

## Considerations

### Technical
- **Image size limits**: Large images may need compression or resizing before sending to API
- **API costs**: Vision calls may cost more than text-only calls
- **Word automation**: Image insertion adds complexity to the VBScript
- **File handling**: Need to manage temporary image files

### User Experience
- Clear UI for selecting and managing images
- Preview images before sending
- Show which images are being processed
- Handle errors gracefully (unsupported formats, too large, etc.)

## Technical Details

### Claude Vision API
- Claude Sonnet 4.5 supports vision via OpenRouter
- Images sent as base64-encoded strings
- Format: `data:image/jpeg;base64,<base64_string>`

### Word Image Insertion (VBScript)
```vbs
' Example structure for inserting images
Set rng = doc.Range(startPos, endPos)
rng.InlineShapes.AddPicture imagePath
rng.InlineShapes(1).Width = 400 ' pixels
rng.InlineShapes(1).Height = 300
```

### Image Storage
- Store uploaded images temporarily in `os.tmpdir()`
- Clean up after Word insertion
- Handle file paths correctly for VBScript

## Status
📋 **Planned** - Ready for implementation when needed

## Notes
- Discussed: [Date of discussion]
- Implementation priority: TBD
- Estimated complexity: Medium-High
