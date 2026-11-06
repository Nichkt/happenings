const year = document.querySelector("[data-current-year]");
if (year) {
  year.textContent = new Date().getFullYear().toString();
}

const gallery = document.querySelector("[data-gallery]");
const galleryButtons = document.querySelectorAll("[data-gallery-button]");

if (gallery && galleryButtons.length) {
  const scrollGallery = (direction) => {
    const card = gallery.querySelector(".screenshot-card");
    const gap = 22;
    const distance = card ? card.getBoundingClientRect().width + gap : 300;

    gallery.scrollBy({
      left: direction === "next" ? distance : -distance,
      behavior: "smooth"
    });
  };

  galleryButtons.forEach((button) => {
    button.addEventListener("click", () => {
      scrollGallery(button.dataset.galleryButton);
    });
  });
}
