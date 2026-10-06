export default defineEventHandler(async (event) => {
  const { group, id, patch } = await readBody(event)
  return useFileStorage().updateMeta({ group, id }, patch)
})
