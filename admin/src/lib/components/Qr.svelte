<script lang="ts">
  import QRCode from 'qrcode';

  let { text, size = 320, label }: { text: string; size?: number; label: string } = $props();
  let src = $state('');

  $effect(() => {
    const t = text;
    QRCode.toDataURL(t, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((u: string) => (src = u))
      .catch(() => (src = ''));
  });
</script>

{#if src}
  <img {src} alt={label} width={size} height={size} />
{/if}

<style>
  img { background: #fff; border-radius: 8px; max-width: 100%; height: auto; image-rendering: pixelated; }
</style>
