export default defineEventHandler(async (event) => {
  const { group, content, ...options } = await readBody(event)
  const storage = useFileStorage()
  const file = await storage.put(group, Buffer.from(content, 'base64'), options)
  return { file, staged: (await storage.list('_ablage-transform')).objects }
})
