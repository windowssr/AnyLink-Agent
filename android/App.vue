<script>
export default {
  onShow() { uni.$emit('anylink.foreground'); },
  onHide() { uni.$emit('anylink.background'); },
  onError() { /* Do not log chat text or connection credentials. */ },
};
</script>
<style>
page { background: #eff6fc; color: #173b55; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
button::after { border: 0; }
button { font-size: 28rpx; }
</style>
