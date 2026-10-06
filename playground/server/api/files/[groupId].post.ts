export default defineEventHandler(async (event) => {
  const group = getRouterParam(event, 'groupId')!;
  const file = await readUploadedFile(event);

  // Opt-in upload-time image processing (`?process=1`): cap to 128px and
  // convert to webp via the optional `sharp` peer dependency. The stored
  // content type and dimensions reflect the processed output.
  const process = getQuery(event).process === '1' && file.type.startsWith('image/');

  return useFileStorage().put(group, file.data, {
    name: file.name,
    contentType: file.type,
    transform: process ? { width: 128, height: 128, format: 'webp' } : undefined,
  });
});
