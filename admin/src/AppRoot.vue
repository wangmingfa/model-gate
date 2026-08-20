<script setup lang="ts">
import { NConfigProvider, NMessageProvider } from 'naive-ui';
import App from './App.vue';
</script>

<template>
  <n-config-provider>
    <n-message-provider>
      <App />
    </n-message-provider>
  </n-config-provider>
</template>
