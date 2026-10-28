import { redirect } from 'next/navigation';

// The front desk starts on the calendar.
export default function Home(): never {
  redirect('/kalendar');
}
