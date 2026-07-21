document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('contactForm');
  const feedback = document.getElementById('formFeedback');

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const message = document.getElementById('message').value.trim();

    if (name && email && message) {
      feedback.classList.remove('hidden');
      form.reset();
    } else {
      alert('Per favore, compila tutti i campi.');
    }
  });
});
