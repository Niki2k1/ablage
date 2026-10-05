export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const id = await useFileStorage().upload(body.groupId, Buffer.from(body.content, 'base64'), {
    meta: { name: 'image.png', mime: 'image/png', type: 'image', version: 1 },
  })
  return { id }
})
