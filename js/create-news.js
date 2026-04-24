// Create News page functionality
let currentUser = null;
let isAdmin = false;

document.addEventListener('DOMContentLoaded', function() {
    initCreateNews();
});

async function initCreateNews() {
    try {
        // Wait for auth state
        currentUser = AppState.currentUser;

        if (!currentUser) {
            // Redirect to login if not authenticated
            window.location.href = 'login.html';
            return;
        }

        // Check user role via API
        try {
            const userProfile = await apiService.getUserProfile();
            isAdmin = userProfile.role === 'admin';

            if (!isAdmin) {
                // Redirect to news page if not admin
                window.location.href = 'news.html';
                return;
            }
        } catch (error) {
            console.error('Error checking user role:', error);
            window.location.href = 'news.html';
            return;
        }

        // Initialize navigation
        if (typeof initNavigation === 'function') {
            initNavigation();
        }

        // Set up form submission
        const form = document.getElementById('createNewsForm');
        if (form) {
            form.addEventListener('submit', handleCreateNews);
        }

    } catch (error) {
        console.error('Error initializing create news:', error);
        showError('Failed to load page. Please try again.');
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

        Swal.fire({
            icon: 'success',
            title: 'News Created!',
            text: 'Your news post has been created successfully.',
            timer: 2000,
            showConfirmButton: false
        });

        // Redirect to news page after success
        setTimeout(() => {
            window.location.href = 'news.html';
        }, 2000);

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
