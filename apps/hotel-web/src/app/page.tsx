import { redirect } from 'next/navigation';

// Until the front-desk calendar exists, the start page is unit setup.
export default function Home(): never {
  redirect('/podesavanja/jedinice');
}
