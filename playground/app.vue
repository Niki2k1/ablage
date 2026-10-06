<template>
  <div style="max-width: 600px; margin: 2rem auto; font-family: sans-serif">
    <h1>ablage playground</h1>

    <div>
      <label>
        Group ID:
        <input v-model="groupId" placeholder="my-group" >
      </label>
    </div>

    <div style="margin-top: 1rem">
      <input type="file" @change="onFileSelect" >
      <button :disabled="!selectedFile" @click="upload">
        Upload
      </button>
    </div>

    <div style="margin-top: 0.5rem">
      <label>
        <input v-model="processImage" type="checkbox" >
        Process image on upload (resize to 128px, convert to webp via sharp)
      </label>
    </div>

    <div v-if="uploadResult" style="margin-top: 1rem; color: green">
      Uploaded: {{ uploadResult.id }}
    </div>

    <div style="margin-top: 2rem; padding: 1rem; border: 1px solid #ccc">
      <h2>Resumable upload (tus)</h2>
      <input type="file" multiple @change="onTusFilesSelect" >
      <ul>
        <li v-for="item in Object.values(tus.items)" :key="item.file.name">
          {{ item.file.name }} — {{ item.progress.toFixed(0) }}%
          <span v-if="item.error" style="color: red">{{ item.error }}</span>
          <span v-else-if="item.complete" style="color: green">staged as {{ item.tusId }}</span>
          <button @click="tus.remove(item.file.name)">✕</button>
        </li>
      </ul>
      <button
        :disabled="tus.uploading.value || !tus.completed.value.length"
        @click="promoteAll"
      >
        Promote {{ tus.completed.value.length }} staged file(s) into "{{ groupId }}"
      </button>
    </div>

    <div style="margin-top: 2rem; padding: 1rem; border: 1px solid #ccc">
      <h2>Direct upload (S3, needs NUXT_S3_*)</h2>
      <input type="file" multiple @change="onDirectFilesSelect" >
      <ul>
        <li v-for="item in Object.values(direct.items)" :key="item.file.name">
          {{ item.file.name }} — {{ item.progress.toFixed(0) }}%
          <span v-if="item.error" style="color: red">{{ item.error }}
            <button @click="direct.retry(item.file)">Retry</button>
          </span>
          <span v-else-if="item.complete" style="color: green">stored as {{ item.result?.id }}</span>
          <button @click="direct.remove(item.file)">✕</button>
        </li>
      </ul>
    </div>

    <div style="margin-top: 2rem">
      <button @click="listFiles">
        List files in "{{ groupId }}"
      </button>
    </div>

    <ul v-if="files.length" style="margin-top: 1rem">
      <li v-for="file in files" :key="file.id" style="margin-bottom: 1rem">
        <strong>{{ file.name }}</strong> ({{ file.contentType }}, {{ file.size }} bytes) — {{ file.id }}
        <div v-if="file.contentType.startsWith('image/')" style="margin-top: 0.5rem; display: flex; gap: 1rem">
          <NuxtImg
            provider="ablage"
            :src="`${file.group}/${file.id}`"
            :width="96"
            :height="96"
            fit="cover"
            format="webp"
            alt="thumbnail via IPX"
          />
          <code>provider=ablage src={{ file.group }}/{{ file.id }}</code>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
const groupId = ref('test-group');
const selectedFile = ref<File | null>(null);
const processImage = ref(false);
const uploadResult = ref<{ id: string } | null>(null);
const files = ref<Array<{ id: string; group: string; name?: string; contentType: string; size: number }>>([]);

function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  selectedFile.value = input.files?.[0] ?? null;
}

async function upload() {
  if (!selectedFile.value) return;

  const formData = new FormData();
  formData.append('file', selectedFile.value);

  uploadResult.value = await $fetch(`/api/files/${groupId.value}`, {
    method: 'POST',
    query: processImage.value ? { process: '1' } : undefined,
    body: formData,
  });
}

async function listFiles() {
  files.value = await $fetch(`/api/files/${groupId.value}`);
}

const tus = useTusUpload({ cleanupOnPageHide: true });

const direct = useDirectUpload<{ id: string }>({
  start: (file) => $fetch('/api/direct/start', {
    method: 'POST',
    body: { group: groupId.value, name: file.name, type: file.type, size: file.size },
  }),
  complete: '/api/direct/complete',
  abort: '/api/direct/abort',
  onSuccess: () => listFiles(),
});

function onDirectFilesSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  direct.add(Array.from(input.files ?? []));
}

function onTusFilesSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  tus.add(Array.from(input.files ?? []));
}

async function promoteAll() {
  for (const item of tus.completed.value) {
    await $fetch('/api/tus/promote', {
      method: 'POST',
      body: { tusId: item.tusId, groupId: groupId.value },
    });
  }
  tus.clear();
  await listFiles();
}
</script>
