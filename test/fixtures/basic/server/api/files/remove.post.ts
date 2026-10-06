export default defineEventHandler(async (event) => {
  const { refs } = await readBody(event)
  await useFileStorage().remove(refs)
  return { removed: refs.length }
})
