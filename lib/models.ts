// The only place that knows the provider's endpoint IDs. Scripts, flags and the `resume`
// command use the neutral keys, so a different provider or a proxy with its own IDs only
// changes the right-hand side here.
export const ENDPOINTS = {
  'gpt-image-2.5': 'openai/gpt-image-2.5/sunburst/text-to-image',
  'gpt-image-2.5-edit': 'openai/gpt-image-2.5/sunburst/edit',
  'nano-banana-2.1': 'google/nano-banana-2.1',
  'nano-banana-2.1-edit': 'google/nano-banana-2.1/edit',
  'remove-background': 'fal-ai/bria/background/remove',
  'recraft-svg': 'fal-ai/recraft/v4.1/text-to-vector',
  'recraft-svg-pro': 'fal-ai/recraft/v4.1/pro/text-to-vector',
  'recraft-vectorize': 'fal-ai/recraft/vectorize',
  'h3-max-text-to-video': 'minimax/h3-max/text-to-video',
  'h3-max-image-to-video': 'minimax/h3-max/image-to-video',
  'kling-4-text-to-video': 'kling/v4/text-to-video',
  'kling-4-image-to-video': 'kling/v4/image-to-video',
  'seedance-2.5-text-to-video': 'bytedance/seedance-2.5/us/text-to-video',
  'seedance-2.5-image-to-video': 'bytedance/seedance-2.5/us/image-to-video',
  'veo-extend': 'fal-ai/veo3.1/extend-video',
} as const

export type Model = keyof typeof ENDPOINTS

export const MODEL_KEYS = Object.keys(ENDPOINTS) as Model[]
