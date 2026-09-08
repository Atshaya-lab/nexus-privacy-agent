import { pipeline, env } from '@xenova/transformers';

console.log('Testing yolos-tiny pipeline initialization...');
const startLoad = performance.now();
const detector = await pipeline('object-detection', 'Xenova/yolos-tiny', { quantized: true });
const loadTime = performance.now() - startLoad;
console.log(`Model loaded in ${loadTime.toFixed(1)}ms`);

// Create a small 100x100 white base64 png data url
const dummyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAALklEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4GQZgAAGzXj5lAAAAAElFTkSuQmCC';

const startInf = performance.now();
const results = await detector(dummyPng);
const infTime = performance.now() - startInf;

console.log(`Inference finished in ${infTime.toFixed(1)}ms`);
console.log('Detection results count:', results.length);
console.log('Detection results sample:', results);
process.exit(0);
