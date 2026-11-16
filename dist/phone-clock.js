(() => {
  const clock = document.querySelector('[data-phone-clock]');
  if (!clock) return;

  const twoDigits = value => String(value).padStart(2, '0');
  let timer;

  function update() {
    clearTimeout(timer);
    const now = new Date();
    const time = `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`;
    clock.textContent = time;
    clock.dateTime = time;

    if (!document.hidden) {
      timer = setTimeout(update, 60000 - now.getTime() % 60000);
    }
  }

  document.addEventListener('visibilitychange', update);
  window.addEventListener('pageshow', update);
  update();
})();
