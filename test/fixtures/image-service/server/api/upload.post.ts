export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const storage = useFileStorage()
  const id = await storage.upload(body.groupId, Buffer.from(body.content, 'base64'), {
    meta: body.meta,
    transform: body.transform,
  })
  return { id, meta: await storage.getMeta(id), staged: await storage.list('_filer-transform') }
})
