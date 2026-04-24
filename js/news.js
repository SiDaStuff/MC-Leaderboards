// News management functionality
let currentUser = null;
let isAdmin = false;
let newsOffset = 0;
const NEWS_PER_PAGE = 10;

document.addEventListener('DOMContentLoaded', function() {
    initNews();
});

async function initNews() {
    try {
        // Wait for authentication to be fully established
        console.log('Waiting for authentication...');
        await new Promise(resolve => {
            const checkAuth = () => {
                if (AppState.currentUser) {
                    resolve();
                } else {
                    // Check again in 100ms
                    setTimeout(checkAuth, 100);
                }
            };
            checkAuth();
        });

        // Now check authentication state
        currentUser = AppState.currentUser;
        console.log('Current user after auth:', currentUser ? currentUser.email : 'Not logged in');

        if (currentUser) {
            // Check user role via API
            try {
                const userProfile = await apiService.getUserProfile();
                isAdmin = userProfile.admin === true || typeof userProfile.adminRole === 'string';
                console.log('User profile:', userProfile);
                console.log('Is admin:', isAdmin);

                // Show create news button if admin
                if (isAdmin) {
                    const createNewsSection = document.getElementById('createNewsSection');
                    console.log('Create news section element:', createNewsSection);
                    if (createNewsSection) {
                        createNewsSection.classList.remove('d-none');
                        console.log('Create news button should now be visible');
                    } else {
                        console.error('createNewsSection element not found');
                    }
                } else {
                    console.log('User is not admin, hiding create news section');
                }
            } catch (error) {
                console.error('Error checking user role:', error);
            }

            // Initialize navigation
            if (typeof initNavigation === 'function') {
                initNavigation();
            }
        } else {
            console.log('No current user, cannot show admin features');
        }

        // Load initial news
        await loadNews();

    } catch (error) {
        console.error('Error initializing news:', error);
        showError('Failed to load news');
    }
}

async function loadNews() {
    try {
        const response = await apiService.getNews(NEWS_PER_PAGE, newsOffset);

        if (response.news && response.news.length > 0) {
            displayNews(response.news);

            // Show load more button if there might be more
            if (response.hasMore) {
                document.getElementById('loadMoreSection').classList.remove('d-none');
            } else {
                document.getElementById('loadMoreSection').classList.add('d-none');
            }
        } else {
            document.getElementById('newsContainer').innerHTML = '<div class="col-12 text-center text-muted">No news available</div>';
        }

    } catch (error) {
        console.error('Error loading news:', error);
        showError('Failed to load news');
    }
}

function displayNews(newsArray) {
    const container = document.getElementById('newsContainer');

    if (newsOffset === 0) {
        container.innerHTML = '';
    }

    newsArray.forEach(news => {
        const newsCard = createNewsCard(news);
        container.appendChild(newsCard);
    });
}

function createNewsCard(news) {
    const col = document.createElement('div');
    col.className = 'col-md-6 mb-4';

    const card = document.createElement('div');
    card.className = 'card news-card';

    // Cover image
    if (news.coverImageUrl) {
        const imageDiv = document.createElement('div');
        imageDiv.className = 'news-cover-image';
        imageDiv.style.backgroundImage = `url(${news.coverImageUrl})`;
        card.appendChild(imageDiv);
    }

    const cardBody = document.createElement('div');
    cardBody.className = 'card-body';

    // Title
    const title = document.createElement('h5');
    title.className = 'card-title news-title';
    title.textContent = news.title;
    cardBody.appendChild(title);

    // Meta info
    const meta = document.createElement('div');
    meta.className = 'news-meta text-muted small mb-3';
    meta.innerHTML = `
        <i class="fas fa-calendar"></i> ${formatDate(news.createdAt)}
        ${news.authorName ? ` • <i class="fas fa-user"></i> ${news.authorName}` : ''}
    `;
    cardBody.appendChild(meta);

    // Preview content (truncated)
    const preview = document.createElement('div');
    preview.className = 'news-preview';
    const truncatedContent = news.content.length > 200 ?
        news.content.substring(0, 200) + '...' :
        news.content;
    preview.innerHTML = marked.parse(truncatedContent);
    cardBody.appendChild(preview);

    // Read more button
    const readMoreBtn = document.createElement('button');
    readMoreBtn.className = 'btn btn-link p-0 mt-2';
    readMoreBtn.textContent = 'Read more';
    readMoreBtn.onclick = () => viewFullNews(news);
    cardBody.appendChild(readMoreBtn);

    card.appendChild(cardBody);
    col.appendChild(card);

    return col;
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}

async function viewFullNews(news) {
    try {
        // If we don't have full content, fetch the complete news post
        if (!news.content || news.content.length < 200) {
            const response = await apiService.getNewsPost(news.id);
            news = response.news;
        }

        // Create full news modal
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content modal-lg">
                <div class="modal-header">
                    <h3 class="modal-title">${news.title}</h3>
                    <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    ${news.coverImageUrl ? `<div class="news-full-image mb-4"><img src="${news.coverImageUrl}" alt="${news.title}" style="width: 100%; border-radius: 8px;"></div>` : ''}
                    <div class="news-meta text-muted small mb-3">
                        <i class="fas fa-calendar"></i> ${formatDate(news.createdAt)}
                        ${news.authorName ? ` • <i class="fas fa-user"></i> ${news.authorName}` : ''}
                    </div>
                    <div class="news-content">
                        ${marked.parse(news.content)}
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
    } catch (error) {
        console.error('Error fetching full news post:', error);
        Swal.fire('Error', 'Failed to load full news post', 'error');
    }
}



async function processCoverImageForUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        throw new Error('Please select a valid image file');
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
        throw new Error('Image file must be smaller than 5MB');
    }

    // Resize and crop image to fit cover dimensions (e.g., 800x400)
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    return new Promise((resolve, reject) => {
        img.onload = () => {
            try {
                // Calculate dimensions for center crop to 800x400
                const targetWidth = 800;
                const targetHeight = 400;
                const targetRatio = targetWidth / targetHeight;
                const imgRatio = img.width / img.height;

                let sourceX, sourceY, sourceWidth, sourceHeight;

                if (imgRatio > targetRatio) {
                    // Image is wider than target, crop sides
                    sourceWidth = img.height * targetRatio;
                    sourceHeight = img.height;
                    sourceX = (img.width - sourceWidth) / 2;
                    sourceY = 0;
                } else {
                    // Image is taller than target, crop top/bottom
                    sourceWidth = img.width;
                    sourceHeight = img.width / targetRatio;
                    sourceX = 0;
                    sourceY = (img.height - sourceHeight) / 2;
                }

                canvas.width = targetWidth;
                canvas.height = targetHeight;

                ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);

                canvas.toBlob(async (blob) => {
                    try {
                        const reader = new FileReader();
                        reader.onload = () => {
                            // Return base64 data URL
                            resolve(reader.result);
                        };
                        reader.onerror = () => reject(new Error('Failed to read image file'));
                        reader.readAsDataURL(blob);
                    } catch (error) {
                        reject(new Error('Failed to process image: ' + error.message));
                    }
                }, 'image/jpeg', 0.8);
            } catch (error) {
                reject(new Error('Failed to process image: ' + error.message));
            }
        };

        img.onerror = () => reject(new Error('Failed to load image. Please try a different image file.'));
        img.src = URL.createObjectURL(file);
    });
}

function loadMoreNews() {
    newsOffset += NEWS_PER_PAGE;
    loadNews();
}

function toggleCreateNewsForm() {
    const formSection = document.getElementById('createNewsFormSection');
    const isVisible = !formSection.classList.contains('d-none');

    if (isVisible) {
        // Hide form
        formSection.classList.add('d-none');
        document.getElementById('createNewsForm').reset();
    } else {
        // Show form
        formSection.classList.remove('d-none');
        document.getElementById('newsTitle').focus();
    }
}

async function handleCreateNews(event) {
    event.preventDefault();

    const title = document.getElementById('newsTitle').value.trim();
    const content = document.getElementById('newsContent').value.trim();
    const coverImageFile = document.getElementById('newsCoverImage').files[0];

    if (!title || !content) {
        Swal.fire('Error', 'Title and content are required', 'error');
        return;
    }

    // Show loading state
    const submitBtn = event.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';

    try {
        let coverImage = null;

        // Process cover image if provided
        if (coverImageFile) {
            try {
                coverImage = await processCoverImageForUpload(coverImageFile);
            } catch (imageError) {
                console.error('Image processing error:', imageError);
                Swal.fire('Warning', 'Image processing failed: ' + imageError.message + '. Continuing without cover image.', 'warning');
                // Continue without cover image
            }
        }

        // Create news post via backend API
        const response = await apiService.createNews(title, content, coverImage);

        // Reset form and hide
        document.getElementById('createNewsForm').reset();
        toggleCreateNewsForm();

        Swal.fire({
            icon: 'success',
            title: 'News Created!',
            text: 'Your news post has been created successfully.',
            timer: 2000,
            showConfirmButton: false
        });

        // Reload news to show the new post
        newsOffset = 0;
        await loadNews();

    } catch (error) {
        console.error('Error creating news:', error);
        Swal.fire('Error', error.message || 'Failed to create news post', 'error');
    } finally {
        // Reset button state
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
    }
}

async function processCoverImageForUpload(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
        throw new Error('Please select a valid image file');
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
        throw new Error('Image file must be smaller than 5MB');
    }

    // Resize and crop image to fit cover dimensions (e.g., 800x400)
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    return new Promise((resolve, reject) => {
        img.onload = () => {
            try {
                // Calculate dimensions for center crop to 800x400
                const targetWidth = 800;
                const targetHeight = 400;
                const targetRatio = targetWidth / targetHeight;
                const imgRatio = img.width / img.height;

                let sourceX, sourceY, sourceWidth, sourceHeight;

                if (imgRatio > targetRatio) {
                    // Image is wider than target, crop sides
                    sourceWidth = img.height * targetRatio;
                    sourceHeight = img.height;
                    sourceX = (img.width - sourceWidth) / 2;
                    sourceY = 0;
                } else {
                    // Image is taller than target, crop top/bottom
                    sourceWidth = img.width;
                    sourceHeight = img.width / targetRatio;
                    sourceX = 0;
                    sourceY = (img.height - sourceHeight) / 2;
                }

                canvas.width = targetWidth;
                canvas.height = targetHeight;

                ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);

                canvas.toBlob(async (blob) => {
                    try {
                        const reader = new FileReader();
                        reader.onload = () => {
                            // Return base64 data URL
                            resolve(reader.result);
                        };
                        reader.onerror = () => reject(new Error('Failed to read image file'));
                        reader.readAsDataURL(blob);
                    } catch (error) {
                        reject(new Error('Failed to process image: ' + error.message));
                    }
                }, 'image/jpeg', 0.8);
            } catch (error) {
                reject(new Error('Failed to process image: ' + error.message));
            }
        };

        img.onerror = () => reject(new Error('Failed to load image. Please try a different image file.'));
        img.src = URL.createObjectURL(file);
    });
}

function showError(message) {
    Swal.fire('Error', message, 'error');
}

// Form submission handler
document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('createNewsForm');
    if (form) {
        form.addEventListener('submit', handleCreateNews);
    }
});

// Debug functions - available in browser console
if (typeof window !== 'undefined') {
    window.showCreateNewsButton = () => {
        document.getElementById('createNewsSection').classList.remove('d-none');
        console.log('Create news button manually shown for debugging');
    };

    window.checkAdminStatus = () => {
        console.log('Current user:', AppState.currentUser);
        console.log('Is admin:', isAdmin);
        console.log('Create news section visible:', !document.getElementById('createNewsSection').classList.contains('d-none'));
    };
}

