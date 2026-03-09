## Future Investigations

### ML-based frame segmentation (pre-processor Option 3)
The current frame detection pre-processors (`variance_scan` and `trim`) handle solid
and lightly-textured borders well, but struggle with ornate or highly irregular decorative
frames. A more robust approach would use a pre-trained ML model to segment the painting
region from the surrounding frame.

**Candidate approach**: ONNX Runtime (`onnxruntime-node`) with a fine-tuned segmentation
model such as SAM (Segment Anything Model) or SegFormer, trained or prompted on artwork
with frames. The model would output a bounding box or mask for the innermost painting content.

**Cost**: ~50–200 MB model weights bundled with the add-on Docker image; `onnxruntime-node`
dependency (~100 MB); additional startup latency on first inference.

**Integration point**: Add as `ml_segment` in `PRE_PROCESSORS` in
`app/utils/imageProcessor.js`, following the existing pre-processor interface
`async (buffer, options) → Buffer`. Add to `IMAGE_PROCESSING_SCHEMA.preProcessors`
and the `PUT /api/web-sources/image-processing` validation list.

### Virtual TV for test-fetch orientation preview
The test-fetch UI currently accepts a `tvOrientation` to simulate fetching for a
specific TV orientation (used with the `match_tv` filter). However, users without a
portrait-mounted physical TV cannot easily test portrait-mode artwork selection.

Investigate adding a "virtual TV" concept: a named configuration entry with no
physical IP, used purely for test-fetch with a fixed orientation. This would let
users preview how the orientation filter behaves in portrait mode without owning
portrait-mounted hardware.

See the `POST /api/web-sources/test-fetch` route in `routes/web_sources.js` and
the `tvOrientation` parameter.