export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  return useFileStorage().put(body.groupId, Buffer.from(body.content, 'base64'), { contentType: 'image/png', name: 'image.png' })
})
