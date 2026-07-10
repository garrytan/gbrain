When you use ML Kit for features such as face mesh, object detection, or pose
detection, the most common failure point is the coordinate disparity between the
analysis image and the viewfinder UI.

## The mapping mindset

| Dimension | Analysis frame | Viewfinder UI on the screen |
|---|---|---|
| Resolution | Fixed, such as 640x480 | Dynamic, such as 1080x2400 |
| Rotation | 0° for the raw buffer | 90° or 270° in portrait or landscape mode |
| Origin | Top-left of buffer at (0,0) | Top-left of screen at (0,0) |

*** ** * ** ***

## Follow the implementation guide

### Coordinate transformation matrix

Android provides the `Viewport` and `UseCaseGroup` APIs to calculate the
transformation matrix automatically. **Don't** calculate aspect ratio scaling
manually.


```kotlin
val transform = previewView.viewPort?.let { viewPort ->
    // Use CameraX's built-in coordinate mapper
    viewPort.getTransformationMatrix(imageProxy.imageInfo.rotationDegrees)
}
```

<br />

### Handling the "double rotation" bug

ML Kit results, bounding boxes, are relative to the **rotated buffer**. If the
device is in portrait, the buffer is often 480x640, landscape, but the screen
is 1080x1920.

To map the coordinates, use the following workflow:

1. Query `imageProxy.imageInfo.rotationDegrees`.
2. Pass this rotation to the ML Kit `InputImage`.
3. Use the `MappingUtils.transformRect` method to map the result `Rect` to the screen.

### Face mesh and pose normalization

For high-precision spatial analysis, for example, "Is the user's hand at a
specific screen button?", use **normalized coordinates from 0.0 to 1.0**.


```kotlin
// Example: Converting a Pose landmark to a Screen Coordinate
val screenX = landmark.position.x / analysisWidth * screenWidth
val screenY = landmark.position.y / analysisHeight * screenHeight
```

<br />

**Warning** : Always account for **mirrored lenses** . If the `LENS_FACING_FRONT`
is used, you must flip the X-coordinate: `actualX = screenWidth - screenX`.

### Overlays and canvas clipping

Use a custom `GraphicOverlay` view on top of the `PreviewView`.

- **Buffer lock** : Ensure your `GraphicOverlay` clears its canvas every time a new `ImageAnalysis` frame is processed to prevent "ghosting" of bounding boxes.

*** ** * ** ***

## Spatial pitfalls

- **The "stretched box" bug** : Caused by assuming the Analysis Frame aspect ratio, 4:3, matches the screen aspect ratio, 21:9. Use `PreviewView.SCALE_TYPE_FILL_CENTER` and map coordinates accordingly.
- **Latency** : If ML processing exceeds 50 ms, the bounding box trails behind the user's face.
  - **Fix** : Use `ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST` to avoid queuing stale frames.
- **Sensor vs. display rotation** : On some tablets, the sensor is mounted horizontally. Always query `display.rotation` and `cameraInfo.sensorRotationDegrees`.