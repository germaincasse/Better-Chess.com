// Runs in the page's own JS world: exposes the logged-in chess.com username to the content script.
(() => {
  const publish = () => {
    const username = window.context?.user?.username;
    if (username) document.documentElement.dataset.cceUser = username;
    return !!username;
  };
  if (publish()) return;
  let tries = 0;
  const timer = setInterval(() => {
    if (publish() || ++tries > 40) clearInterval(timer);
  }, 500);
})();
