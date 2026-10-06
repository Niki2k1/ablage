// `content` is text, or base64 when `base64: true`; the other fields are PutOptions.
export default defineEventHandler(async (event) => {
  const { group, content, base64, ...options } = await readBody(event)
  return useFileStorage().put(group, Buffer.from(content, base64 ? 'base64' : 'utf8'), options)
})
