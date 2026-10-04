<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

require_admin();

$data   = body();
$action = field($data, 'action');

switch ($action) {
    case 'add':
        $title   = mb_substr(field($data, 'title'), 0, 180);
        $message = mb_substr(field($data, 'message'), 0, 2000);
        $icon    = mb_substr(field($data, 'icon'), 0, 16) ?: '👏';

        if ($title === '' || $message === '') {
            throw new ApiError('Please enter an announcement title and message.');
        }

        $stmt = db()->prepare('INSERT INTO announcements (title, message, icon) VALUES (?, ?, ?)');
        $stmt->execute([$title, $message, $icon]);
        ok();
        break;

    case 'delete':
        $id = (int) ($data['id'] ?? 0);
        if ($id <= 0) {
            throw new ApiError('Invalid announcement.');
        }
        $stmt = db()->prepare('DELETE FROM announcements WHERE id = ?');
        $stmt->execute([$id]);
        ok();
        break;

    default:
        throw new ApiError('Unknown announcement action.', 400);
}
