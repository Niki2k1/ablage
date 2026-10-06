export default defineEventHandler(async (event) => {
  const { tusId, group, ...options } = await readBody(event)
  return useTusStaging().promote(tusId, group, options)
})
