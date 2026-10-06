export default defineEventHandler(async (event) => {
  const { token } = await readBody(event);
  await useFileStorage().abortUpload(token);
  return null;
});
