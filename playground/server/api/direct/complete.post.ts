export default defineEventHandler(async (event) => {
  const { token, parts } = await readBody(event);
  return await useFileStorage().completeUpload(token, { parts });
});
